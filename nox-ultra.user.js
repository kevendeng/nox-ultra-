// ==UserScript==
// @name         NoxInfluencer Ultra (Auto)
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  全局自动化:输入关键词→自动跨平台搜索→自动收藏进当天收藏夹(满了换下一个)。含旧版全部功能。
// @match        https://cn.noxinfluencer.com/*
// @grant        none
// @run-at       document-end
// @require      https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js
// @updateURL    https://raw.githubusercontent.com/kevendeng/nox-ultra-/main/nox-ultra.user.js
// @downloadURL  https://raw.githubusercontent.com/kevendeng/nox-ultra-/main/nox-ultra.user.js
// ==/UserScript==
(function () {
    'use strict';
    // 统一版本号:以后升级只改这一处(以及头部 @version),面板标题/日志会自动跟着变,
    // 避免出现“头部 8.6、面板还写 8.5”这种对不上的情况。
    var SCRIPT_VERSION = '2.5-ultra';
    console.log('Nox Ultra V' + SCRIPT_VERSION + ' started');
    var isScriptRunning = false;
    var stopRequested = false;
    var totalUsersChecked = 0;
    var maxCheckLimit = 1000;
    var CHECK_DELAY = 800;
    var NEXT_PAGE_WAIT_TIME = 2500;
    function sleep(ms) {
        return new Promise(function (resolve, reject) {
            if (stopRequested) return reject(new Error('stopped'));
            setTimeout(function () {
                if (stopRequested) return reject(new Error('stopped'));
                resolve();
            }, ms);
        });
    }
    function sleepPlain(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function isElementVisible(elem) {
        if (!elem) return false;
        var rect = elem.getBoundingClientRect();
        return (rect.width > 0 && rect.height > 0 && window.getComputedStyle(elem).display !== 'none');
    }
    async function waitForPageReady(timeout) {
        timeout = timeout || 20000;
        var startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            if (stopRequested) throw new Error('stopped');
            var items = document.querySelectorAll('.youtube-channel-item');
            var selectAll = document.querySelector('.result-pagination-left .el-checkbox__input');
            if (items.length > 0 && selectAll) { await sleep(1000); return true; }
            await sleep(500);
        }
        return false;
    }
    // 平台编号:instagram=6(已确认)。其它平台的值待确认，先按常见约定猜，认不出时兜底 6 并在控制台提示。
    // 从当前网址自动识别，用户无需手动输入。
    var PLATFORM_MAP = { instagram: 6, youtube: 1, tiktok: 10, twitter: 3, twitch: 5 };
    function getPlatformFromUrl() {
        var m = location.pathname.match(/\/search\/([^\/]+)/) || location.pathname.match(/\/lookalike\/([^\/]+)/);
        var key = m ? m[1].toLowerCase() : '';
        if (PLATFORM_MAP[key]) return PLATFORM_MAP[key];
        console.log('[collect] 未知平台"' + key + '"，暂用 6(instagram)。如收藏到错平台请反馈。');
        return 6;
    }
    // 拉取收藏夹列表(名字→ID)。返回 [{id, name, remainder, createTime}, ...]，按创建时间倒序(最新在前)。
    var __noxGroupCache = null;
    var FOLDER_CAP = 5000; // 每个收藏夹固定容量上限
    async function fetchGroups(force) {
        if (__noxGroupCache && !force) return __noxGroupCache;
        var res = await fetch('https://cn.noxinfluencer.com/ws/collection/simpleGroupList', { credentials: 'include' });
        var d = await res.json();
        var arr = (d && d.retDataList) || [];
        arr = arr.map(function (g) {
            // filled = 已填入人数 = 上限 - 剩余。用户关心的是“已经装了多少人”，不是剩余额度。
            var rem = (g.remainder != null) ? g.remainder : null;
            var filled = (rem != null) ? (FOLDER_CAP - rem) : null;
            return { id: g.id, name: g.name, remainder: rem, filled: filled, createTime: g.createTime || 0 };
        }).sort(function (a, b) { return (b.createTime || 0) - (a.createTime || 0); });
        __noxGroupCache = arr;
        return arr;
    }
    // 只抓“可见”达人的 channelId。被隐藏(建联过/已合作)的达人带 .youtube-channel-fade，一律排除。
    // 再叠加 offsetParent 判断作双保险。channelId 从卡片里 /channel/<id> 链接抠出。
    // 注意:不同平台 id 格式不同——instagram 是纯数字(20575005572)，YouTube 是 UCxxx 字母串。
    // 所以匹配 /channel/ 后到下一个斜杠/问号/井号前的整段，不能只认数字。
    function getVisibleChannelIds() {
        var items = document.querySelectorAll('.youtube-channel-item:not(.youtube-channel-fade)');
        var ids = [];
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.offsetParent === null) continue; // 双保险:确实在页面上渲染出来的
            var a = item.querySelector('a[href*="/channel/"]');
            if (!a) continue;
            var mm = (a.getAttribute('href') || '').match(/\/channel\/([^\/?#]+)/);
            if (mm) ids.push(mm[1]);
        }
        // 去重(卡片里有多个同 id 链接)
        var seen = {}, out = [];
        for (var j = 0; j < ids.length; j++) { if (!seen[ids[j]]) { seen[ids[j]] = 1; out.push(ids[j]); } }
        return out;
    }
    // 智能等待本页渲染稳定：不仅要有卡片，还要“可见达人数量”连续几次不变，
    // 确保 .youtube-channel-fade(隐藏标记)已经渲染上去——否则会抢在隐藏生效前把建联过的人误当可见。
    async function waitForCollectPageReady(timeout) {
        timeout = timeout || 25000;
        var startTime = Date.now();
        var lastCount = -1, stableTimes = 0;
        while (Date.now() - startTime < timeout) {
            if (stopRequested) throw new Error('stopped');
            var items = document.querySelectorAll('.youtube-channel-item');
            if (items.length > 0) {
                var visCount = getVisibleChannelIds().length;
                if (visCount === lastCount) {
                    stableTimes++;
                    // 连续 3 次(约 1.2s)可见数不变，认定渲染稳定
                    if (stableTimes >= 3) return true;
                } else {
                    stableTimes = 0;
                    lastCount = visCount;
                }
            }
            await sleep(400);
        }
        // 超时也返回当前状态(有卡片就继续，靠上面的稳定判断已尽量兜住)
        return document.querySelectorAll('.youtube-channel-item').length > 0;
    }
    // 调收藏接口:一次把本页可见达人加入指定收藏夹。同源 fetch，鉴权靠 cookie 自动带。
    async function collectViaApi(ids, groupIds, platform) {
        var res = await fetch('https://cn.noxinfluencer.com/ws/collection', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ channelIds: ids, platform: platform, groupIds: groupIds })
        });
        var body = null;
        try { body = await res.json(); } catch (e) { try { body = await res.text(); } catch (e2) { body = null; } }
        return { status: res.status, body: body };
    }
    // 处理当前页:等渲染稳 → 抓可见 id(不超过剩余名额) → 调接口收藏。返回本页实际收藏数。
    async function processCurrentPage() {
        if (totalUsersChecked >= maxCheckLimit) { stopRequested = true; return 0; }
        setCollectStatus('第' + currentPageNum + '页：等待渲染…');
        var isReady = await waitForCollectPageReady();
        if (!isReady) { setCollectStatus('第' + currentPageNum + '页：未渲染出结果'); return 0; }
        var ids = getVisibleChannelIds();
        if (!ids.length) { setCollectStatus('第' + currentPageNum + '页：本页无可见达人(全隐藏)，跳过'); return 0; }
        var remaining = maxCheckLimit - totalUsersChecked;
        if (ids.length > remaining) ids = ids.slice(0, remaining);
        setCollectStatus('第' + currentPageNum + '页：收藏 ' + ids.length + ' 个…');
        var r = await collectViaApi(ids, collectGroupIds, collectPlatform);
        if (r.status !== 200) {
            throw new Error('收藏接口返回 ' + r.status + '，已停止。请检查登录状态或收藏夹。');
        }
        totalUsersChecked += ids.length;
        updateButtonText();
        setCollectStatus('已收藏 ' + totalUsersChecked + '/' + maxCheckLimit + '（第' + currentPageNum + '页 +' + ids.length + '）');
        return ids.length;
    }
    async function goToNextPage() {
        var nextPageButton = document.querySelector('.search-pagination-container .right');
        if (nextPageButton && !nextPageButton.classList.contains('disabled') && isElementVisible(nextPageButton)) {
            nextPageButton.click();
            return true;
        }
        return false;
    }
    var collectGroupIds = [];
    var collectPlatform = 6;
    // 已选收藏夹:{id, name} 数组，由下拉多选维护
    var selectedGroups = [];
    // 全自动“选取收藏夹”待确认态:收集完输入后,等用户在多选框里取消不要的,再点确认开跑
    var ultraPending = null;
    var ultraConfirmBtn = null;
    var ultraRefreshLogCount = null; // 面板构建后指向"刷新已记录批数"的函数
    async function startBatchProcess() {
        if (isScriptRunning) return;
        var userLimit = parseInt(limitInput.value, 10);
        if (isNaN(userLimit) || userLimit <= 0) { alert('请输入有效的目标数量'); return; }
        if (!selectedGroups.length) { alert('请先在上面选择要收藏进哪个收藏夹'); return; }
        var groupIds = selectedGroups.map(function (g) { return g.id; });
        var groupNames = selectedGroups.map(function (g) { return g.name; });
        // 平台从当前网址自动识别，用户无需输入
        var platform = getPlatformFromUrl();
        collectGroupIds = groupIds;
        collectPlatform = platform;
        if (!confirm('将把可见达人收藏进：\n' + groupNames.join('、') + '\n目标 ' + userLimit + ' 个。\n(已建联/隐藏的达人会自动跳过) 开始吗？')) return;
        maxCheckLimit = userLimit;
        isScriptRunning = true;
        stopRequested = false;
        totalUsersChecked = 0;
        currentPageNum = 1;
        updateUIStatus(true);
        var stopMsg = '';
        try {
            while (!stopRequested && totalUsersChecked < maxCheckLimit) {
                await processCurrentPage();
                if (stopRequested || totalUsersChecked >= maxCheckLimit) break;
                setCollectStatus('已收藏 ' + totalUsersChecked + '/' + maxCheckLimit + '，翻到第' + (currentPageNum + 1) + '页…');
                var hasNext = await goToNextPage();
                if (!hasNext) { stopMsg = '已到最后一页。'; break; }
                currentPageNum++;
                await sleep(NEXT_PAGE_WAIT_TIME);
            }
        } catch (error) {
            console.log(error.message);
            if (error.message !== 'stopped') stopMsg = error.message;
        } finally {
            isScriptRunning = false;
            updateUIStatus(false);
            setCollectStatus((stopMsg ? stopMsg + ' ' : '') + '完成，共收藏 ' + totalUsersChecked + ' 个');
            // 收藏后刷新收藏夹列表，"已装人数"会更新
            loadGroupsIntoPanel(true);
            alert((stopMsg ? stopMsg + '\n' : '') + '完成，共收藏 ' + totalUsersChecked + ' 个达人。');
        }
    }
    // ==================== ULTRA 全自动模块(第一步:YouTube 单平台) ====================
    // 搜索页 URL 的 ?p= = urlencode( base64( zlib.deflate( urlencode(JSON) ) ) )。
    // 已在本地验证解码/改词/重新编码往返一致;这里用 pako(@require 引入)复现浏览器端编码。
    function ultraDecodeP(p) {
        var s = decodeURIComponent(p);
        var bytes = Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); });
        var inner = pako.inflate(bytes, { to: 'string' });
        return JSON.parse(decodeURIComponent(inner));
    }
    function ultraEncodeP(obj) {
        var inner = encodeURIComponent(JSON.stringify(obj));
        var comp = pako.deflate(inner, { level: 6 }); // zlib 格式(带头),与 python zlib.compress 一致
        var b64 = btoa(String.fromCharCode.apply(null, comp));
        return encodeURIComponent(b64);
    }
    // 从当前搜索页 URL 抓 ?p= 解出的模板对象;抓不到返回 null。
    function ultraGetTemplateFromUrl() {
        var m = location.search.match(/[?&]p=([^&]+)/);
        if (!m) return null;
        try { return ultraDecodeP(m[1]); } catch (e) { console.log('[ultra] 解析当前URL的p失败:', e && e.message); return null; }
    }
    function ultraMakeWord(v, exclude) {
        return { target: 5, isSelected: '', value: v, edit: 0, isDelete: 0, exclude: exclude || 0, targetSelect: '', targetSelectShow: false };
    }
    // 用模板对象 + 一组搜索词 + 平台,生成完整搜索页 URL。
    // words = 搜索词数组(exclude:0);模板里原有的排除词(exclude:1)保留。
    var ULTRA_PLATFORM_PATH = { 1: 'youtube', 6: 'instagram', 10: 'tiktok' };
    var ULTRA_PLATFORM_NAME = { 1: 'YouTube', 6: 'Instagram', 10: 'TikTok' };
    // 跨平台跑的顺序:每批词依次在这三个平台各搜一次并收藏(共用同一套词/筛选/当天收藏夹)
    var ULTRA_PLATFORM_ORDER = [1, 6, 10];
    // 每个平台最多收多少个达人就切下一个(设为 0 表示不限,收满整批直到翻完最后一页或收藏夹满)。
    // >0 为测试模式:每平台只收这么多、且 probe 单词即定批,用于快速验证三平台抓取。
    var ULTRA_PER_PLATFORM_LIMIT = 0;
    function ultraBuildUrl(template, words, platform) {
        var obj = JSON.parse(JSON.stringify(template));
        var excludes = (obj.wordsList || []).filter(function (w) { return w.exclude === 1; });
        obj.wordsList = words.map(function (v) { return ultraMakeWord(v, 0); }).concat(excludes);
        if (!obj.hideChannelFilter) obj.hideChannelFilter = {};
        obj.hideChannelFilter.platform = platform;
        var pathName = ULTRA_PLATFORM_PATH[platform] || 'youtube';
        return location.origin + '/search/' + pathName + '/channel?p=' + ultraEncodeP(obj);
    }
    // 读页面上的结果总数。形如 "1.47万 条结果" / "4万+ 条结果" / "532 条结果"。返回整数(万→*10000)。
    function ultraReadResultCount() {
        var el = document.querySelector('.result-count') || document.querySelector('[class*="result-count"]');
        if (!el) return null;
        var txt = (el.textContent || '').replace(/[,\s]/g, '');
        var m = txt.match(/([\d.]+)(万|万\+|\+)?/);
        if (!m) return null;
        var num = parseFloat(m[1]);
        if (m[2] && m[2].indexOf('万') !== -1) num *= 10000;
        return Math.round(num);
    }
    // ---- 状态持久化(跨页面跳转靠它续跑) ----
    var ULTRA_LS = 'noxUltra.state';
    function ultraLoadState() {
        try { return JSON.parse(localStorage.getItem(ULTRA_LS) || 'null'); } catch (e) { return null; }
    }
    function ultraSaveState(st) {
        try { if (st) st._ts = Date.now(); localStorage.setItem(ULTRA_LS, JSON.stringify(st)); } catch (e) {}
    }
    function ultraClearState() {
        try { localStorage.removeItem(ULTRA_LS); } catch (e) {}
    }
    // ---- 批次历史日志(累积,跨任务保留,可导出 CSV) ----
    // 记录:每次成功收藏一页,追加一条 {time, words:[本批词], platform:平台名, folder:收藏夹名, count:本次收藏数}
    var ULTRA_LOG_LS = 'noxUltra.batchLog';
    function ultraLoadLog() {
        try { return JSON.parse(localStorage.getItem(ULTRA_LOG_LS) || '[]'); } catch (e) { return []; }
    }
    function ultraSaveLog(list) {
        try { localStorage.setItem(ULTRA_LOG_LS, JSON.stringify(list)); } catch (e) {}
    }
    function ultraAppendLog(words, platformName, folderName, count) {
        var list = ultraLoadLog();
        var now = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        var ts = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
            + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
        var wordsArr = (words || []).slice();
        var wordsKey = wordsArr.join(' + ');
        var plat = platformName || '';
        var fold = folderName || '';
        // 合并:同一批词 + 同平台 + 同收藏夹 的多页,累加到同一条(收藏数相加,更新时间)。
        // 从后往前找最近一条匹配的,避免跨很久的旧记录被误并。
        var merged = false;
        for (var i = list.length - 1; i >= 0; i--) {
            var e = list[i];
            if ((e.words || []).join(' + ') === wordsKey && (e.platform || '') === plat && (e.folder || '') === fold) {
                e.count = (e.count || 0) + (count || 0);
                e.time = ts; // 记最后一次收藏时间
                merged = true;
                break;
            }
        }
        if (!merged) {
            list.push({ time: ts, words: wordsArr, platform: plat, folder: fold, count: count || 0 });
        }
        ultraSaveLog(list);
        if (typeof ultraRefreshLogCount === 'function') ultraRefreshLogCount();
    }
    // 导出批次历史为 CSV:时间、关键词、平台、收藏夹、收藏数量
    function ultraExportLog() {
        var list = ultraLoadLog();
        if (!list.length) { alert('还没有批次记录。跑一次全自动收藏后再导出。'); return; }
        var rows = [['时间', '关键词', '平台', '收藏夹', '收藏数量']];
        for (var i = 0; i < list.length; i++) {
            var r = list[i];
            rows.push([
                r.time || '',
                (r.words || []).join(' + '),
                r.platform || '',
                r.folder || '',
                String(r.count == null ? '' : r.count)
            ]);
        }
        var esc = function (s) {
            s = String(s == null ? '' : s);
            if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
            return s;
        };
        var csv = rows.map(function (row) { return row.map(esc).join(','); }).join('\r\n');
        var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        var now = new Date();
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        a.href = url;
        a.download = 'nox-batch-log-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
    // 统一跳转:任务循环里所有 location.href 都走这里。
    // 若此刻用户在收藏夹/邮件/CRM 页(SPA 软导航过去干活),不要跳走打断——
    // 自动暂停(running=false,保留状态),等回搜索页或点"继续"再续跑。返回是否真的跳了。
    function ultraNavigate(url) {
        if (isFolderPage() || isEmailPage() || isCrmPage()) {
            var st = ultraLoadState();
            if (st) { st.running = false; ultraSaveState(st); }
            ultraStatus('检测到你切到了其它页面,已自动暂停(进度已保留)。回搜索页或点"继续"接着跑。');
            return false;
        }
        location.href = url;
        return true;
    }
    // 今天日期前缀,如 8月4日 -> "0804"
    function ultraTodayPrefix() {
        var d = new Date();
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return mm + dd;
    }
    // 从收藏夹全量里,挑出名字以今天前缀开头的,按创建时间正序(旧在前,依次填满)。
    // 名字含字母 m -> 上限 500,其余 -> 1000。返回 [{id,name,cap,filled}...]
    // allowIds:可选的 id 白名单(数组或对象)。传了就只保留其中的收藏夹(用于用户手动取消了一部分)。
    function ultraPickTodayFolders(groups, prefix, allowIds) {
        var pfx = prefix || ultraTodayPrefix();
        // 只在最新建的前 100 个收藏夹里找,排除掉去年同前缀(如去年 0806)的老夹子。
        // groups 按创建时间倒序(最新在前),取前 100 即最近建的。
        var recent = groups.slice(0, 100);
        var todays = recent.filter(function (g) { return (g.name || '').indexOf(pfx) === 0; });
        // 反转成正序(先建的先填)
        todays = todays.slice().reverse();
        // 白名单过滤:只留用户勾选的
        if (allowIds) {
            var allow = {};
            (Array.isArray(allowIds) ? allowIds : Object.keys(allowIds)).forEach(function (id) { allow[String(id)] = 1; });
            todays = todays.filter(function (g) { return allow[String(g.id)]; });
        }
        return todays.map(function (g) {
            var cap = /m/i.test(g.name || '') ? 500 : 1000;
            return { id: g.id, name: g.name, cap: cap, filled: (g.filled != null ? g.filled : 0) };
        });
    }
    // ---- 状态机 ----
    var ULTRA_TARGET_DEFAULT = 10000;
    var ultraBusy = false; // 防止一次加载里重入
    function ultraStatus(t) { setCollectStatus('[全自动] ' + t); console.log('[ultra] ' + t); }

    // 启动:抓当前URL筛选模板 → 收词 → 建状态 → 跳第一个探测URL
    async function startUltra() {
        var existing = ultraLoadState();
        if (existing && existing.running) {
            if (!confirm('已有一个全自动任务在进行,重新开始会覆盖它。继续?')) return;
        }
        var template = ultraGetTemplateFromUrl();
        if (!template) { alert('没能从当前页面URL读到筛选条件。请先在搜索页调好筛选(地区/粉丝/邮箱等)并搜索一次,URL里要带 ?p=,再点全自动。'); return; }
        var raw = prompt('粘贴关键词,每行一个:');
        if (!raw || !raw.trim()) return;
        var words = raw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        if (!words.length) return;
        var tgtRaw = prompt('每批目标结果数(累计达到就定为一批,默认 10000):', String(ULTRA_TARGET_DEFAULT));
        var target = parseInt(tgtRaw, 10);
        if (isNaN(target) || target <= 0) target = ULTRA_TARGET_DEFAULT;
        // 收藏夹日期前缀:默认今天,允许改(方便测试/补跑)
        var prefix = prompt('收藏进哪个日期前缀的收藏夹?(名字以此开头,含字母 m 的上限 500,其余 1000)', ultraTodayPrefix());
        if (prefix == null) return;
        prefix = prefix.trim();
        if (!prefix) { alert('前缀不能为空'); return; }
        // 启动即校验:有没有匹配的收藏夹,没有当场提示,别白跑
        ultraStatus('检查以 "' + prefix + '" 开头的收藏夹…');
        var groupsChk;
        try { groupsChk = await fetchGroups(true); } catch (e) { alert('拉取收藏夹失败,检查登录状态'); return; }
        var matched = ultraPickTodayFolders(groupsChk, prefix);
        if (!matched.length) {
            alert('没有找到以 "' + prefix + '" 开头的收藏夹。请先建好再点全自动。');
            return;
        }
        // 把匹配到的当天收藏夹填进多选框、默认全选,让用户取消掉要用别的方法找达人的那几个。
        // 存下待确认信息,点“✅ 确认开始”按钮时再真正开跑。
        ultraShowFolderPicker(matched, { template: template, words: words, target: target, prefix: prefix });
    }
    // 把当天收藏夹填进面板多选框并全选,显示“确认开始”按钮,进入待确认态
    function ultraShowFolderPicker(matched, info) {
        if (!groupSelectEl) { alert('面板还没加载好,稍等再点'); return; }
        // 用前缀作过滤词,把当天收藏夹显示出来
        if (groupFilterInput) groupFilterInput.value = info.prefix;
        if (__noxGroupCache) populateGroupOptions(__noxGroupCache, info.prefix);
        // 勾选匹配到的这些(其余不勾)
        var matchIds = {};
        matched.forEach(function (f) { matchIds[String(f.id)] = 1; });
        eachGroupCheckbox(function (cb) { cb.checked = !!matchIds[cb.value]; });
        syncSelectedGroups();
        ultraPending = info;
        ultraStatus('已列出 ' + matched.length + ' 个收藏夹并全选。取消掉不要的,再点“✅ 确认开始”。');
        if (ultraConfirmBtn) ultraConfirmBtn.style.display = 'block';
    }
    // 点“确认开始”:读当前多选框里选中的收藏夹,过滤后开跑
    async function ultraConfirmStart() {
        if (!ultraPending) return;
        var info = ultraPending;
        // 当前选中的 id
        var chosenIds = selectedGroups.map(function (g) { return g.id; });
        if (!chosenIds.length) { alert('至少选一个收藏夹。'); return; }
        // 重新拉最新收藏夹,按选中 id 过滤(保证 filled/顺序最新)
        var groupsChk;
        try { groupsChk = await fetchGroups(true); } catch (e) { alert('拉取收藏夹失败,检查登录状态'); return; }
        var matched = ultraPickTodayFolders(groupsChk, info.prefix, chosenIds);
        if (!matched.length) { alert('选中的收藏夹里没有匹配当天前缀的,重选。'); return; }
        var capInfo = matched.map(function (f) { return f.name + '(' + f.filled + '/' + f.cap + ')'; }).join('\n');
        if (!confirm('将按此顺序依次填满这 ' + matched.length + ' 个收藏夹:\n' + capInfo + '\n\n关键词 ' + info.words.length + ' 个,每批目标 ' + info.target + '。开始吗?')) return;
        // 搜索框最多 20 个词(含排除词)。正常词能加的上限 = 20 - 模板里已有的排除词数。
        var excludeCount = ((info.template.wordsList || []).filter(function (w) { return w.exclude === 1; })).length;
        var maxWords = Math.max(1, 20 - excludeCount);
        var platformOrder = ULTRA_PLATFORM_ORDER.slice();
        var st = {
            running: true, platform: platformOrder[0], template: info.template,
            platformOrder: platformOrder, platformIdx: 0,
            remainingWords: info.words.slice(1), batchWords: [info.words[0]],
            target: info.target, prefix: info.prefix, maxWords: maxWords,
            folderIds: chosenIds, // 记住用户勾选的收藏夹,续跑/换平台时按此过滤
            phase: 'probe', folders: null, folderIdx: 0,
            stats: { batches: 0, collected: 0 }
        };
        ultraSaveState(st);
        ultraPending = null;
        if (ultraConfirmBtn) ultraConfirmBtn.style.display = 'none';
        ultraStatus('开始,第1批探测:' + st.batchWords.join(' + '));
        location.href = ultraBuildUrl(info.template, st.batchWords, st.platform);
    }
    // 页面加载后驱动:根据 state.phase 继续。改URL会重载,所以每次加载都要 tick 一次。
    async function ultraTick() {
        var st = ultraLoadState();
        if (!st || !st.running) return;
        if (ultraBusy) return;
        ultraBusy = true;
        try {
            if (st.phase === 'probe') await ultraDoProbe(st);
            else if (st.phase === 'collect') await ultraDoCollect(st);
        } catch (e) {
            console.log('[ultra] tick 出错:', e && e.message);
            ultraStatus('出错:' + (e && e.message) + '(已暂停,可点停止清理)');
        } finally {
            ultraBusy = false;
        }
    }

    // 探测:当前URL对应 batchWords。读结果数;够 target 或没词可加 → 定批转 collect;否则加一个词跳新URL。
    async function ultraDoProbe(st) {
        ultraStatus('探测中 (' + st.batchWords.join(' + ') + ') …等结果数');
        // 等结果数出现(最多约12秒)
        var count = null, waited = 0;
        while (waited < 12000) {
            count = ultraReadResultCount();
            if (count != null) break;
            await sleepPlain(500); waited += 500;
        }
        if (count == null) {
            ultraStatus('读不到结果数,按“够一批”处理,进入收藏');
            st.phase = 'collect'; st.folders = null; st.folderIdx = 0; st.platformCollected = 0; ultraSaveState(st);
            return ultraDoCollect(st);
        }
        ultraStatus('当前批 [' + st.batchWords.join(' + ') + '] 结果约 ' + count + ' 条');
        var maxWords = st.maxWords || 20;
        // 测试模式:每平台只收少量,不需要累加词凑大结果集,单词直接定批
        var testMode = ULTRA_PER_PLATFORM_LIMIT > 0;
        // 已到搜索框词数上限,不能再加了 → 直接定批
        if (testMode || count >= st.target || st.remainingWords.length === 0 || st.batchWords.length >= maxWords) {
            if (st.batchWords.length >= maxWords && count < st.target) {
                ultraStatus('已达搜索框 ' + maxWords + ' 词上限,直接定批收藏');
            }
            // 定批,进入收藏
            st.phase = 'collect'; st.folders = null; st.folderIdx = 0; st.platformCollected = 0; ultraSaveState(st);
            await sleepPlain(600);
            return ultraDoCollect(st);
        }
        // 还不够且还有词:加一个词,跳新URL(重载后继续 probe)
        var next = st.remainingWords.shift();
        st.batchWords.push(next);
        ultraSaveState(st);
        await sleepPlain(400);
        ultraNavigate(ultraBuildUrl(st.template, st.batchWords, st.platform));
    }
    // 收藏:本批(当前URL已是最终词组)。逐页抓可见达人,按收藏夹上限依次填满换下一个。
    async function ultraDoCollect(st) {
        // 首次进入本批:准备今天的收藏夹队列
        if (!st.folders) {
            var groups = await fetchGroups(true);
            st.folders = ultraPickTodayFolders(groups, st.prefix, st.folderIds);
            st.folderIdx = 0;
            ultraSaveState(st);
            if (!st.folders.length) {
                ultraStatus('没有以 "' + st.prefix + '" 开头的收藏夹,任务停止。请先新建当天收藏夹。');
                st.running = false; ultraSaveState(st);
                alert('全自动停止:没有以 "' + st.prefix + '" 开头的收藏夹。请先建好当天收藏夹再重试。');
                return;
            }
        }
        // 本平台本批已收数(测试模式用:到上限就切下一平台)。每次进入 collect(即每个平台)从 0 起。
        if (st.platformCollected == null) { st.platformCollected = 0; ultraSaveState(st); }
        var pageNum = 0;
        while (true) {
            // 每轮开头重读状态:用户点“停止”会把 running 置 false / 清空,这里要能立刻退出
            var live = ultraLoadState();
            if (!live || !live.running) { ultraStatus('已停止。'); return; }
            // 找到还没满的收藏夹
            while (st.folderIdx < st.folders.length && st.folders[st.folderIdx].filled >= st.folders[st.folderIdx].cap) {
                st.folderIdx++;
            }
            if (st.folderIdx >= st.folders.length) {
                ultraStatus('今天的收藏夹全部装满,任务停止。');
                st.running = false; ultraSaveState(st);
                alert('全自动停止:今天的收藏夹都装满了(共 ' + st.folders.length + ' 个)。请新建更多收藏夹。');
                return;
            }
            var folder = st.folders[st.folderIdx];
            pageNum++;
            ultraStatus('批' + (st.stats.batches + 1) + ' 收藏进 [' + folder.name + '] ' + folder.filled + '/' + folder.cap + ',第' + pageNum + '页…');
            var ready = await waitForCollectPageReady();
            if (!ready) { ultraStatus('本页未渲染出结果,跳过'); }
            else {
                var ids = getVisibleChannelIds();
                if (ids.length) {
                    var room = folder.cap - folder.filled;
                    if (ids.length > room) ids = ids.slice(0, room);
                    // 测试模式:本平台最多收 ULTRA_PER_PLATFORM_LIMIT 个
                    if (ULTRA_PER_PLATFORM_LIMIT > 0) {
                        var platRoom = ULTRA_PER_PLATFORM_LIMIT - st.platformCollected;
                        if (ids.length > platRoom) ids = ids.slice(0, platRoom);
                    }
                    if (ids.length) {
                        var r = await collectViaApi(ids, [folder.id], st.platform);
                        if (r.status !== 200) {
                            ultraStatus('收藏接口返回 ' + r.status + ',暂停。请检查登录/收藏夹。');
                            st.running = false; ultraSaveState(st);
                            alert('全自动暂停:收藏接口返回 ' + r.status + '。请检查登录状态后重试。');
                            return;
                        }
                        folder.filled += ids.length;
                        st.stats.collected += ids.length;
                        st.platformCollected += ids.length;
                        ultraSaveState(st);
                        // 记一条批次历史:本批词 -> 收进了哪个收藏夹(累积,可导出)
                        ultraAppendLog(st.batchWords, ULTRA_PLATFORM_NAME[st.platform] || ('平台' + st.platform), folder.name, ids.length);
                    }
                }
                // 测试模式:本平台已达上限,当作“本平台本批收完”,走切平台逻辑
                if (ULTRA_PER_PLATFORM_LIMIT > 0 && st.platformCollected >= ULTRA_PER_PLATFORM_LIMIT) {
                    ultraStatus('批' + (st.stats.batches + 1) + ' 在 ' + (ULTRA_PLATFORM_NAME[st.platform] || st.platform) + ' 已收满 ' + ULTRA_PER_PLATFORM_LIMIT + ' 个(测试上限)。');
                    if (await ultraAdvancePlatformOrBatch(st)) return;
                    return;
                }
            }
            // 翻页
            var hasNext = await goToNextPage();
            if (!hasNext) {
                var curName = ULTRA_PLATFORM_NAME[st.platform] || ('平台' + st.platform);
                ultraStatus('批' + (st.stats.batches + 1) + ' 在 ' + curName + ' 已到最后一页。');
                await ultraAdvancePlatformOrBatch(st);
                return;
            }
            await sleep(NEXT_PAGE_WAIT_TIME);
        }
    }
    // 当前平台本批收完(到平台上限 / 翻到最后一页):切下一平台;三平台都完了就进下一批词。
    async function ultraAdvancePlatformOrBatch(st) {
        var order = st.platformOrder || [st.platform];
        // 还有下一个平台:同一批词换平台继续收(共用同一批收藏夹,不重置 folders)
        if (st.platformIdx + 1 < order.length) {
            st.platformIdx++;
            st.platform = order[st.platformIdx];
            st.platformCollected = 0; // 新平台从 0 计数
            st.phase = 'collect'; // 词已定,换平台直接收藏,不再 probe
            ultraSaveState(st);
            var nextName = ULTRA_PLATFORM_NAME[st.platform] || ('平台' + st.platform);
            ultraStatus('批' + (st.stats.batches + 1) + ' 切到 ' + nextName + ' 继续收藏…');
            await sleepPlain(600);
            ultraNavigate(ultraBuildUrl(st.template, st.batchWords, st.platform));
            return true;
        }
        // 三平台都跑完:本批完成
        st.stats.batches++;
        ultraStatus('批' + st.stats.batches + ' 三平台全部完成。');
        if (st.remainingWords.length === 0) {
            st.running = false; ultraSaveState(st);
            ultraStatus('全部完成!共收藏 ' + st.stats.collected + ' 个,跑了 ' + st.stats.batches + ' 批。');
            alert('全自动完成!\n共收藏 ' + st.stats.collected + ' 个达人,' + st.stats.batches + ' 批(每批 YouTube/Instagram/TikTok 三平台)。');
            return true;
        }
        // 下一批:回到第一个平台重新 probe,取下一个词起头
        st.phase = 'probe';
        st.platformIdx = 0;
        st.platform = order[0];
        st.platformCollected = 0;
        st.batchWords = [st.remainingWords.shift()];
        ultraSaveState(st);
        await sleepPlain(600);
        ultraNavigate(ultraBuildUrl(st.template, st.batchWords, st.platform));
        return true;
    }
    // 暂停:只把 running 置 false,保留全部任务状态。正在跑的 tick 循环下一轮读到 running=false 会退出。
    // 状态还在,可随时"继续"接着跑。
    function pauseUltra() {
        var st = ultraLoadState();
        if (!st) { ultraStatus('没有进行中的全自动任务。'); return; }
        st.running = false; ultraSaveState(st);
        ultraStatus('已暂停(已收藏 ' + (st.stats ? st.stats.collected : 0) + ' 个)。点"继续全自动"接着跑。');
    }
    // 继续:恢复 running=true,统一通过导航让 ultraAutoResume 接手续跑,避免出现两个 tick 循环重入。
    //  - 不在搜索结果页:跳回该批词的搜索 URL,重载后自动续跑
    //  - 已在搜索结果页:reload 当前页,重载后自动续跑
    function resumeUltra() {
        var st = ultraLoadState();
        if (!st) { ultraStatus('没有可继续的任务。请点"全自动"重新开始。'); return; }
        st.running = true; ultraSaveState(st);
        ultraStatus('继续中,正在跳回搜索页…');
        if (!isSearchResultPage()) {
            try { location.href = ultraBuildUrl(st.template, st.batchWords, st.platform); }
            catch (e) { ultraStatus('继续失败:' + (e && e.message) + '。可点"全自动"重开。'); }
        } else {
            location.reload();
        }
    }
    // 彻底停止并清理状态(不可继续)。用于任务作废、换任务重开等。
    function stopUltra() {
        var st = ultraLoadState();
        if (st) { st.running = false; ultraSaveState(st); }
        ultraClearState();
        ultraStatus('已停止并清理。');
    }
    // ULTRA_PLACEHOLDER
    var kwSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    function getKwInput() {
        return document.querySelector('input.search-value-input')
            || document.querySelector('.input-content input')
            || document.querySelector('.input-box input')
            || document.querySelector('.search-input-fix input');
    }
    function focusInputBox() {
        var box = document.querySelector('.input-content')
               || document.querySelector('.input-box')
               || document.querySelector('.search-input-fix');
        if (box) {
            ['mousedown', 'mouseup', 'click'].forEach(function (type) {
                box.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            });
        }
    }
    async function addWord(kw) {
        var before = document.querySelectorAll('.keywords-item').length;
        for (var t = 0; t < 4; t++) {
            focusInputBox();
            await sleepPlain(350);
            var input = getKwInput();
            if (!input) { await sleepPlain(300); continue; }
            input.focus();
            kwSetter.call(input, kw);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await sleepPlain(600);
            var evs = ['keydown', 'keypress', 'keyup'];
            for (var k = 0; k < evs.length; k++) {
                input.dispatchEvent(new KeyboardEvent(evs[k], { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
            }
            await sleepPlain(800);
            if (document.querySelectorAll('.keywords-item').length > before) return true;
        }
        return false;
    }
    async function runKeywords() {
        var raw = prompt('Paste keywords, one per line:');
        if (!raw || !raw.trim()) return;
        keywordButton.disabled = true;
        var oldText = keywordButton.textContent;
        function countExclude() { return document.querySelectorAll('.keywords-item.is-exclude').length; }
        var excludeBaseline = countExclude();
        var guard = 0;
        while (guard++ < 60) {
            var normals = document.querySelectorAll('.keywords-item:not(.is-exclude)');
            if (!normals.length) break;
            var item = normals[0];
            var x = item.querySelector('.kol-icon-close-filled') || item.querySelector('[class*="close"]');
            if (!x) break;
            var beforeTotal = document.querySelectorAll('.keywords-item').length;
            x.click();
            await sleepPlain(350);
            if (countExclude() !== excludeBaseline) {
                console.log('[keywords] aborted cleanup: an exclude word was affected');
                break;
            }
            if (document.querySelectorAll('.keywords-item').length >= beforeTotal) break;
        }
        var keywords = raw.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        var failed = [];
        for (var i = 0; i < keywords.length; i++) {
            if (document.querySelectorAll('.keywords-item').length >= 20) {
                for (var j = i; j < keywords.length; j++) failed.push(keywords[j]);
                break;
            }
            keywordButton.textContent = 'adding ' + (i + 1) + '/' + keywords.length;
            var ok = await addWord(keywords[i]);
            if (!ok) failed.push(keywords[i]);
            await sleepPlain(300);
        }
        keywordButton.disabled = false;
        keywordButton.textContent = oldText;
        if (failed.length) alert('Done, but failed: ' + failed.join(', '));
        else alert('All keywords added!');
    }
    var startButton, stopButton, limitInput, controlsDiv, keywordButton;
    var groupFilterInput, groupSelectEl, groupRefreshBtn, groupSelectedLabel, collectStatusEl;
    var currentPageNum = 0;
    function setCollectStatus(t) { if (collectStatusEl) collectStatusEl.textContent = t; }
    function isFolderPage() { return location.href.indexOf('/resource-folder/') !== -1; }
    function isEmailPage() { return location.href.indexOf('/email/') !== -1; }
    function isCrmPage() { return location.href.indexOf('/crm-detail/') !== -1; }
    // 精确判断:是不是真正的搜索结果页(/search/xxx/channel)。全自动只在这种页跑。
    function isSearchResultPage() { return /\/search\/[^\/]+\/channel/.test(location.pathname); }
    function currentPageType() {
        if (isFolderPage()) return 'folder';
        if (isEmailPage()) return 'email';
        if (isCrmPage()) return 'crm';
        return 'search';
    }
    // 是不是脚本要挂面板的功能页。全站加载后,首页等非功能页不建面板(避免到处弹浮窗)。
    function isPanelPage() {
        return isSearchResultPage() || isFolderPage() || isEmailPage() || isCrmPage();
    }
    var LS_CODES = 'nox-folder-codes';
    var folderStopRequested = false;
    function getSavedCodes() {
        try { return localStorage.getItem(LS_CODES) || ''; } catch (e) { return ''; }
    }
    function saveCodes(text) {
        try { localStorage.setItem(LS_CODES, text); } catch (e) {}
    }
    function parseCodeLine(line) {
        line = line.trim();
        if (!line) return null;
        var code = line, collabs = [];
        var gt = line.indexOf('>');
        if (gt !== -1) {
            code = line.slice(0, gt).trim();
            var rest = line.slice(gt + 1).trim();
            collabs = rest.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
        }
        if (!code) return null;
        return { code: code, collaborators: collabs };
    }
    function openCreateDialog() {
        var btns = document.querySelectorAll('button, .create-btn, [class*="create"]');
        for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').replace(/\s/g, '');
            if (t.indexOf('创建') !== -1 && isElementVisible(btns[i])) { btns[i].click(); return true; }
        }
        return false;
    }
    function getDialog() {
        var dialogs = document.querySelectorAll('.el-dialog__wrapper');
        for (var i = 0; i < dialogs.length; i++) {
            if (isElementVisible(dialogs[i]) && dialogs[i].querySelector('.pool-name-input')) return dialogs[i];
        }
        return null;
    }
    async function waitForDialog(timeout) {
        timeout = timeout || 6000;
        var start = Date.now();
        while (Date.now() - start < timeout) {
            var d = getDialog();
            if (d) return d;
            await sleepPlain(200);
        }
        return null;
    }
    function setFolderName(dialog, name) {
        var input = dialog.querySelector('.pool-name-input input') || dialog.querySelector('.el-input__inner');
        if (!input) return false;
        input.focus();
        kwSetter.call(input, name);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    async function setScopeAndCollaborators(dialog, collaborators) {
        var scope = dialog.querySelector('.pool-scope') || dialog;
        if (collaborators.length === 0) {
            var radios = scope.querySelectorAll('.el-radio');
            for (var i = 0; i < radios.length; i++) {
                if ((radios[i].textContent || '').indexOf('私有') !== -1) { radios[i].click(); break; }
            }
            return { notFound: [] };
        }
        var radios2 = scope.querySelectorAll('.el-radio');
        for (var j = 0; j < radios2.length; j++) {
            if ((radios2[j].textContent || '').indexOf('部分可见') !== -1) { radios2[j].click(); break; }
        }
        await sleepPlain(400);
        var trigger = scope.querySelector('.el-select') || dialog.querySelector('.el-select');
        if (trigger) { trigger.click(); await sleepPlain(500); }
        var notFound = [];
        for (var c = 0; c < collaborators.length; c++) {
            var want = collaborators[c].trim().toLowerCase();
            var dd = document.querySelector('.progress-cooperator-select') ||
                     document.querySelector('.el-select-dropdown.is-multiple');
            var items = dd ? dd.querySelectorAll('.el-select-dropdown__item') : [];
            var pool = [];
            for (var k = 0; k < items.length; k++) {
                if (items[k].classList.contains('is-disabled')) continue;
                var labelEl = items[k].querySelector('.el-checkbox__label') || items[k];
                var nm = (labelEl.textContent || '').trim().toLowerCase();
                pool.push({ el: items[k], name: nm, short: nm.split('@')[0] });
            }
            var target = null;
            for (var p = 0; p < pool.length; p++) { if (pool[p].name === want) { target = pool[p]; break; } }
            if (!target) { for (var p2 = 0; p2 < pool.length; p2++) { if (pool[p2].short === want) { target = pool[p2]; break; } } }
            if (!target) { for (var p3 = 0; p3 < pool.length; p3++) { if (pool[p3].name.indexOf(want) !== -1) { target = pool[p3]; break; } } }
            if (target) {
                var alreadyChecked = target.el.querySelector('.el-checkbox__input.is-checked');
                if (!alreadyChecked) target.el.click();
                await sleepPlain(250);
            } else {
                notFound.push(collaborators[c]);
            }
        }
        var header = dialog.querySelector('.el-dialog__title') || dialog.querySelector('.el-dialog__header');
        if (header) header.click();
        await sleepPlain(300);
        return { notFound: notFound };
    }
    function confirmDialog(dialog) {
        var candidates = dialog.querySelectorAll('.kol-btn, button');
        for (var i = 0; i < candidates.length; i++) {
            if (!isElementVisible(candidates[i])) continue;
            var t = (candidates[i].textContent || '').replace(/\s/g, '');
            if (t.indexOf('确认') !== -1 || t.indexOf('确定') !== -1) { candidates[i].click(); return true; }
        }
        var primary = dialog.querySelector('.kol-btn.primary');
        if (primary && isElementVisible(primary)) { primary.click(); return true; }
        return false;
    }
    async function createOneFolder(name, collaborators) {
        if (!openCreateDialog()) return { ok: false, reason: '找不到创建按钮' };
        var dialog = await waitForDialog();
        if (!dialog) return { ok: false, reason: '弹窗没出现' };
        await sleepPlain(300);
        if (!setFolderName(dialog, name)) return { ok: false, reason: '找不到名称框' };
        await sleepPlain(300);
        var res = await setScopeAndCollaborators(dialog, collaborators);
        await sleepPlain(300);
        if (!confirmDialog(dialog)) return { ok: false, reason: '找不到确认按钮' };
        var start = Date.now();
        while (Date.now() - start < 5000) {
            if (!getDialog()) return { ok: true, notFound: res.notFound };
            await sleepPlain(300);
        }
        var d2 = getDialog();
        if (d2) {
            var cancelBtns = d2.querySelectorAll('.kol-btn, button');
            for (var i = 0; i < cancelBtns.length; i++) {
                if ((cancelBtns[i].textContent || '').replace(/\s/g, '').indexOf('取消') !== -1) { cancelBtns[i].click(); break; }
            }
        }
        return { ok: false, reason: '确认后未关闭(可能重名)', notFound: res.notFound };
    }
    var folderRunning = false;
    async function runCreateFolders() {
        if (folderRunning) return;
        var prefix = (folderPrefixInput.value || '').trim();
        if (!prefix) { alert('请先输入日期前缀，例如 0708'); return; }
        var raw = folderCodesInput.value || '';
        saveCodes(raw);
        var lines = raw.split('\n').map(parseCodeLine).filter(Boolean);
        if (lines.length === 0) { alert('请先填写编号列表'); return; }
        if (!confirm('将要创建 ' + lines.length + ' 个收藏夹，前缀 "' + prefix + '"。开始吗？')) return;
        folderRunning = true;
        folderStopRequested = false;
        folderCreateBtn.disabled = true;
        folderStopBtn.style.display = 'block';
        var created = 0, failed = [], notFoundCollabs = {};
        for (var i = 0; i < lines.length; i++) {
            if (folderStopRequested) break;
            var name = prefix + '-' + lines[i].code;
            folderCreateBtn.textContent = '创建中 ' + (i + 1) + '/' + lines.length;
            var r = await createOneFolder(name, lines[i].collaborators);
            if (r.ok) {
                created++;
                if (r.notFound && r.notFound.length) r.notFound.forEach(function (n) { notFoundCollabs[n] = true; });
            } else {
                failed.push(name + '（' + r.reason + '）');
            }
            await sleepPlain(800);
        }
        folderRunning = false;
        folderCreateBtn.disabled = false;
        folderStopBtn.style.display = 'none';
        folderCreateBtn.textContent = '开始批量创建';
        var msg = '完成！成功创建 ' + created + ' 个。';
        if (failed.length) msg += '\n失败 ' + failed.length + ' 个：\n' + failed.join('\n');
        var nf = Object.keys(notFoundCollabs);
        if (nf.length) msg += '\n\n这些协作者名字没匹配到（检查拼写）：' + nf.join('、');
        alert(msg);
    }
    var folderPrefixInput, folderCodesInput, folderCreateBtn, folderStopBtn;
    function updateUIStatus(running) {
        startButton.disabled = running;
        stopButton.style.display = running ? 'block' : 'none';
        limitInput.disabled = running;
        if (groupSelectEl) { groupSelectEl.style.opacity = running ? '0.5' : '1'; groupSelectEl.style.pointerEvents = running ? 'none' : 'auto'; }
        if (groupFilterInput) groupFilterInput.disabled = running;
        if (groupRefreshBtn) groupRefreshBtn.disabled = running;
        if (!running) {
            startButton.textContent = '开始收藏(自动翻页)';
            startButton.style.backgroundColor = '#4CAF50';
        }
    }
    function updateButtonText() {
        if (isScriptRunning) {
            startButton.textContent = '收藏中 (' + totalUsersChecked + '/' + maxCheckLimit + ')';
            startButton.style.backgroundColor = '#FFA500';
        }
    }
    function makeDraggable(panel, handle) {
        var startX, startY, startLeft, startTop, dragging = false;
        try {
            var saved = JSON.parse(localStorage.getItem('nox-panel-pos') || 'null');
            if (saved && typeof saved.left === 'number') {
                panel.style.left = saved.left + 'px';
                panel.style.top = saved.top + 'px';
                panel.style.right = 'auto';
            }
        } catch (e) {}
        handle.addEventListener('mousedown', function (e) {
            dragging = true;
            var rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';
            panel.style.right = 'auto';
            e.preventDefault();
        });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            var newLeft = startLeft + (e.clientX - startX);
            var newTop = startTop + (e.clientY - startY);
            newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - panel.offsetWidth));
            newTop = Math.max(0, Math.min(newTop, window.innerHeight - panel.offsetHeight));
            panel.style.left = newLeft + 'px';
            panel.style.top = newTop + 'px';
        });
        document.addEventListener('mouseup', function () {
            if (!dragging) return;
            dragging = false;
            try {
                localStorage.setItem('nox-panel-pos', JSON.stringify({
                    left: parseInt(panel.style.left, 10),
                    top: parseInt(panel.style.top, 10)
                }));
            } catch (e) {}
        });
    }
    function initializeControls() {
        if (document.getElementById('nox-script-ui')) return;
        controlsDiv = document.createElement('div');
        controlsDiv.id = 'nox-script-ui';
        controlsDiv.setAttribute('data-page', currentPageType());
        controlsDiv.style.position = 'fixed';
        controlsDiv.style.top = '100px';
        controlsDiv.style.right = '20px';
        controlsDiv.style.zIndex = '2147483647';
        controlsDiv.style.backgroundColor = '#ffffff';
        controlsDiv.style.border = '2px solid #007bff';
        controlsDiv.style.borderRadius = '8px';
        controlsDiv.style.padding = '15px';
        controlsDiv.style.display = 'flex';
        controlsDiv.style.flexDirection = 'column';
        controlsDiv.style.gap = '10px';
        controlsDiv.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
        controlsDiv.style.width = '180px';
        controlsDiv.style.fontFamily = 'sans-serif';
        var title = document.createElement('div');
        title.textContent = '✥ Nox Helper v' + SCRIPT_VERSION + ' (drag)';
        title.style.textAlign = 'center';
        title.style.fontWeight = 'bold';
        title.style.cursor = 'move';
        title.style.userSelect = 'none';
        title.title = 'Drag me to move the panel';
        makeDraggable(controlsDiv, title);
        controlsDiv.appendChild(title);
        if (isFolderPage()) {
            buildFolderPanel(controlsDiv);
        } else if (isEmailPage()) {
            buildEmailPanel(controlsDiv);
        } else if (isCrmPage()) {
            buildCrmPanel(controlsDiv);
        } else {
            buildSearchPanel(controlsDiv);
        }
        document.body.appendChild(controlsDiv);
        console.log('Nox UI mounted v' + SCRIPT_VERSION);
    }
    // 用过滤词刷新下拉里的收藏夹选项。filter 为空则显示最新的 MAX 个。
    function populateGroupOptions(groups, filter) {
        if (!groupSelectEl) return;
        var kw = (filter || '').trim().toLowerCase();
        // 没输过滤词:只显示最新创建的 50 个(倒序,最新在前),保持清爽;
        // 一旦输入过滤词:在全部收藏夹里搜,覆盖全量。
        var shown;
        if (!kw) {
            shown = groups.slice(0, 50);
        } else {
            shown = groups.filter(function (g) {
                return (g.name || '').toLowerCase().indexOf(kw) !== -1;
            });
        }
        // 记住已选中的 id，重建后尽量保持勾选
        var prevSel = {};
        selectedGroups.forEach(function (g) { prevSel[g.id] = 1; });
        groupSelectEl.innerHTML = '';
        shown.forEach(function (g) {
            var row = document.createElement('label');
            row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;border-bottom:1px solid #f0f0f0;';
            row.addEventListener('mouseenter', function () { row.style.background = '#f5f5f5'; });
            row.addEventListener('mouseleave', function () { row.style.background = '#fff'; });
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = String(g.id);
            cb.checked = !!prevSel[g.id];
            cb._group = g;
            cb.style.cssText = 'margin:0;flex:0 0 auto;';
            cb.addEventListener('change', syncSelectedGroups);
            var txt = document.createElement('span');
            txt.textContent = g.name + '  (已装' + (g.filled != null ? g.filled : '?') + '人)';
            txt.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            row.appendChild(cb);
            row.appendChild(txt);
            groupSelectEl.appendChild(row);
        });
        if (groupSelectedLabel) groupSelectedLabel.textContent = '';
    }
    // 遍历列表里的复选框
    function eachGroupCheckbox(fn) {
        if (!groupSelectEl) return;
        var cbs = groupSelectEl.querySelectorAll('input[type=checkbox]');
        for (var i = 0; i < cbs.length; i++) fn(cbs[i], i);
    }
    function setAllGroupChecks(checked) {
        eachGroupCheckbox(function (cb) { cb.checked = checked; });
        syncSelectedGroups();
    }
    function syncSelectedGroups() {
        selectedGroups = [];
        eachGroupCheckbox(function (cb) {
            if (cb.checked && cb._group) selectedGroups.push({ id: cb._group.id, name: cb._group.name });
        });
        try { localStorage.setItem('nox-collect-group-ids', JSON.stringify(selectedGroups.map(function (g) { return g.id; }))); } catch (e) {}
    }
    async function loadGroupsIntoPanel(force) {
        if (!groupSelectEl) return;
        if (groupSelectedLabel) groupSelectedLabel.textContent = '正在加载收藏夹…';
        try {
            var groups = await fetchGroups(force);
            populateGroupOptions(groups, groupFilterInput ? groupFilterInput.value : '');
        } catch (e) {
            if (groupSelectedLabel) groupSelectedLabel.textContent = '加载收藏夹失败，点🔄重试';
            console.log('[collect] 加载收藏夹失败:', e && e.message);
        }
    }
    function buildSearchPanel(root) {
        root.style.width = '240px';
        keywordButton = document.createElement('button');
        keywordButton.textContent = 'Input keywords';
        keywordButton.style.padding = '10px';
        keywordButton.style.backgroundColor = '#38cb89';
        keywordButton.style.color = 'white';
        keywordButton.style.border = 'none';
        keywordButton.style.borderRadius = '4px';
        keywordButton.style.cursor = 'pointer';
        keywordButton.style.fontWeight = 'bold';
        keywordButton.addEventListener('click', runKeywords);
        // 全自动按钮(第一步:YouTube 单平台)
        var ultraBtn = document.createElement('button');
        ultraBtn.textContent = '🚀 全自动(输词→搜→收藏)';
        ultraBtn.style.cssText = 'padding:10px;background:#7c3aed;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;';
        ultraBtn.addEventListener('click', startUltra);
        // 选取收藏夹后的“确认开始”按钮:默认隐藏,进入待确认态才显示
        ultraConfirmBtn = document.createElement('button');
        ultraConfirmBtn.textContent = '✅ 确认开始(用选中的收藏夹)';
        ultraConfirmBtn.style.cssText = 'padding:8px;background:#16a34a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:12px;display:none;';
        ultraConfirmBtn.addEventListener('click', ultraConfirmStart);
        // 暂停 / 继续 一行(暂停保留进度,继续接着跑)
        var ultraPauseRow = document.createElement('div');
        ultraPauseRow.style.cssText = 'display:flex;gap:6px;';
        var ultraPauseBtn = document.createElement('button');
        ultraPauseBtn.textContent = '⏸ 暂停';
        ultraPauseBtn.style.cssText = 'flex:1;padding:6px;background:#f59e0b;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;';
        ultraPauseBtn.addEventListener('click', function () { pauseUltra(); });
        var ultraResumeBtn = document.createElement('button');
        ultraResumeBtn.textContent = '▶ 继续';
        ultraResumeBtn.style.cssText = 'flex:1;padding:6px;background:#16a34a;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;';
        ultraResumeBtn.addEventListener('click', function () { resumeUltra(); });
        ultraPauseRow.appendChild(ultraPauseBtn);
        ultraPauseRow.appendChild(ultraResumeBtn);
        // 彻底结束并清理(不可继续),做成不显眼的小链接,避免误点丢进度
        var ultraStopBtn = document.createElement('a');
        ultraStopBtn.textContent = '结束并清理进度';
        ultraStopBtn.href = 'javascript:void(0)';
        ultraStopBtn.style.cssText = 'display:block;text-align:center;color:#9ca3af;font-size:11px;text-decoration:underline;cursor:pointer;';
        ultraStopBtn.addEventListener('click', function () {
            if (!confirm('结束并清理会丢弃当前进度,之后无法"继续"。确定?')) return;
            stopUltra(); ultraPending = null; if (ultraConfirmBtn) ultraConfirmBtn.style.display = 'none';
        });
        // 批次历史导出(每批词 -> 收进哪个收藏夹,累积,可导出 CSV)
        var ultraLogBtn = document.createElement('button');
        ultraLogBtn.textContent = '导出批次记录 CSV';
        ultraLogBtn.title = '导出每批用了哪些词、收进了哪个收藏夹';
        ultraLogBtn.style.cssText = 'padding:8px;background:#607d8b;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;';
        ultraLogBtn.addEventListener('click', ultraExportLog);
        var ultraLogMetaRow = document.createElement('div');
        ultraLogMetaRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#888;';
        var ultraLogCountLabel = document.createElement('span');
        ultraRefreshLogCount = function () { ultraLogCountLabel.textContent = '已记录 ' + ultraLoadLog().length + ' 条(词×收藏夹)'; };
        ultraRefreshLogCount();
        var ultraLogClearBtn = document.createElement('span');
        ultraLogClearBtn.textContent = '清空';
        ultraLogClearBtn.style.cssText = 'color:#f44336;cursor:pointer;text-decoration:underline;';
        ultraLogClearBtn.addEventListener('click', function () {
            if (confirm('确定清空所有批次记录？导出过的文件不受影响。')) {
                ultraSaveLog([]);
                ultraRefreshLogCount();
            }
        });
        ultraLogMetaRow.appendChild(ultraLogCountLabel);
        ultraLogMetaRow.appendChild(ultraLogClearBtn);
        var divider = document.createElement('div');
        divider.style.borderTop = '1px dashed #ccc';
        divider.style.margin = '4px 0';
        // 收藏夹选择区
        var groupLabel = document.createElement('span');
        groupLabel.innerHTML = '收藏进哪个收藏夹 <span style="font-weight:normal;color:#888;">(可多选)</span>:';
        groupLabel.style.fontSize = '12px';
        groupLabel.style.fontWeight = 'bold';
        // 过滤 + 刷新一行
        var filterRow = document.createElement('div');
        filterRow.style.display = 'flex';
        filterRow.style.gap = '4px';
        groupFilterInput = document.createElement('input');
        groupFilterInput.type = 'text';
        groupFilterInput.placeholder = '按名字过滤，如 0730';
        groupFilterInput.style.flex = '1';
        groupFilterInput.style.padding = '5px';
        groupFilterInput.style.border = '1px solid #ccc';
        groupFilterInput.style.borderRadius = '4px';
        groupFilterInput.style.minWidth = '0';
        groupFilterInput.addEventListener('input', function () {
            if (__noxGroupCache) populateGroupOptions(__noxGroupCache, groupFilterInput.value);
        });
        groupRefreshBtn = document.createElement('button');
        groupRefreshBtn.textContent = '🔄';
        groupRefreshBtn.title = '重新拉取收藏夹列表(新建后点这个)';
        groupRefreshBtn.style.cssText = 'padding:5px 8px;border:1px solid #ccc;background:#f5f5f5;border-radius:4px;cursor:pointer;';
        groupRefreshBtn.addEventListener('click', function () { loadGroupsIntoPanel(true); });
        filterRow.appendChild(groupFilterInput);
        filterRow.appendChild(groupRefreshBtn);
        // 全选 / 全不选 一行
        var selRow = document.createElement('div');
        selRow.style.cssText = 'display:flex;gap:10px;font-size:11px;';
        var selAll = document.createElement('a');
        selAll.textContent = '全选';
        selAll.href = 'javascript:void(0)';
        selAll.style.cssText = 'color:#4CAF50;text-decoration:none;cursor:pointer;';
        selAll.addEventListener('click', function () { setAllGroupChecks(true); });
        var selNone = document.createElement('a');
        selNone.textContent = '全不选';
        selNone.href = 'javascript:void(0)';
        selNone.style.cssText = 'color:#888;text-decoration:none;cursor:pointer;';
        selNone.addEventListener('click', function () { setAllGroupChecks(false); });
        selRow.appendChild(selAll);
        selRow.appendChild(selNone);
        // 复选框列表容器(每行一个收藏夹 + 真复选框)
        groupSelectEl = document.createElement('div');
        groupSelectEl.style.cssText = 'width:100%;max-height:150px;overflow-y:auto;border:1px solid #ccc;border-radius:4px;font-size:12px;box-sizing:border-box;background:#fff;';
        groupSelectedLabel = document.createElement('div');
        groupSelectedLabel.style.cssText = 'font-size:11px;color:#888;';
        groupSelectedLabel.textContent = '正在加载收藏夹…';
        limitInput = document.createElement('input');
        limitInput.type = 'number';
        limitInput.value = '1000';
        limitInput.style.padding = '5px';
        limitInput.style.border = '1px solid #ccc';
        startButton = document.createElement('button');
        startButton.textContent = '开始收藏(自动翻页)';
        startButton.style.padding = '10px';
        startButton.style.backgroundColor = '#4CAF50';
        startButton.style.color = 'white';
        startButton.style.border = 'none';
        startButton.style.borderRadius = '4px';
        startButton.style.cursor = 'pointer';
        startButton.style.fontWeight = 'bold';
        stopButton = document.createElement('button');
        stopButton.textContent = 'Stop';
        stopButton.style.padding = '8px';
        stopButton.style.backgroundColor = '#f44336';
        stopButton.style.color = 'white';
        stopButton.style.border = 'none';
        stopButton.style.borderRadius = '4px';
        stopButton.style.cursor = 'pointer';
        stopButton.style.display = 'none';
        startButton.addEventListener('click', startBatchProcess);
        stopButton.addEventListener('click', function () { stopRequested = true; });
        root.appendChild(keywordButton);
        root.appendChild(ultraBtn);
        root.appendChild(ultraConfirmBtn);
        root.appendChild(ultraPauseRow);
        root.appendChild(ultraStopBtn);
        root.appendChild(ultraLogBtn);
        root.appendChild(ultraLogMetaRow);
        root.appendChild(divider);
        root.appendChild(groupLabel);
        root.appendChild(filterRow);
        root.appendChild(selRow);
        root.appendChild(groupSelectEl);
        root.appendChild(groupSelectedLabel);
        var label = document.createElement('span');
        label.textContent = '目标数量:';
        label.style.fontSize = '12px';
        root.appendChild(label);
        root.appendChild(limitInput);
        root.appendChild(startButton);
        root.appendChild(stopButton);
        collectStatusEl = document.createElement('div');
        collectStatusEl.style.cssText = 'font-size:12px;color:#4CAF50;text-align:center;min-height:16px;font-weight:bold;';
        collectStatusEl.textContent = '就绪';
        root.appendChild(collectStatusEl);
        // 面板出现后自动拉一次收藏夹列表
        loadGroupsIntoPanel(false);
    }
    function buildFolderPanel(root) {
        root.style.width = '260px';
        var prefixLabel = document.createElement('span');
        prefixLabel.textContent = '① 日期前缀（每天改这里）:';
        prefixLabel.style.fontSize = '12px';
        prefixLabel.style.fontWeight = 'bold';
        folderPrefixInput = document.createElement('input');
        folderPrefixInput.type = 'text';
        folderPrefixInput.placeholder = '例如 0708';
        folderPrefixInput.style.padding = '6px';
        folderPrefixInput.style.border = '1px solid #ccc';
        folderPrefixInput.style.borderRadius = '4px';
        try { folderPrefixInput.value = localStorage.getItem('nox-folder-prefix') || ''; } catch (e) {}
        folderPrefixInput.addEventListener('input', function () {
            try { localStorage.setItem('nox-folder-prefix', folderPrefixInput.value); } catch (e) {}
        });
        var codesLabel = document.createElement('span');
        codesLabel.innerHTML = '② 编号列表（每行一个，很少改）:<br><span style="font-weight:normal;color:#888;font-size:11px;">格式: 编号 &gt; 协作者1, 协作者2<br>不写协作者=私有</span>';
        codesLabel.style.fontSize = '12px';
        codesLabel.style.fontWeight = 'bold';
        folderCodesInput = document.createElement('textarea');
        folderCodesInput.rows = 8;
        folderCodesInput.placeholder = '1 > Renli\n9 > leta\nm-1\nm-E1 > Renli, leta';
        folderCodesInput.style.padding = '6px';
        folderCodesInput.style.border = '1px solid #ccc';
        folderCodesInput.style.borderRadius = '4px';
        folderCodesInput.style.fontFamily = 'monospace';
        folderCodesInput.style.fontSize = '12px';
        folderCodesInput.style.resize = 'vertical';
        folderCodesInput.value = getSavedCodes();
        folderCodesInput.addEventListener('input', function () { saveCodes(folderCodesInput.value); });
        var previewBtn = document.createElement('button');
        previewBtn.textContent = '预览要建的名字';
        previewBtn.style.padding = '6px';
        previewBtn.style.backgroundColor = '#607d8b';
        previewBtn.style.color = 'white';
        previewBtn.style.border = 'none';
        previewBtn.style.borderRadius = '4px';
        previewBtn.style.cursor = 'pointer';
        previewBtn.style.fontSize = '12px';
        previewBtn.addEventListener('click', function () {
            var prefix = (folderPrefixInput.value || '').trim();
            if (!prefix) { alert('请先输入日期前缀'); return; }
            var lines = (folderCodesInput.value || '').split('\n').map(parseCodeLine).filter(Boolean);
            if (!lines.length) { alert('编号列表是空的'); return; }
            var preview = lines.map(function (l) {
                var s = prefix + '-' + l.code;
                if (l.collaborators.length) s += '   → ' + l.collaborators.join(', ');
                else s += '   → 私有';
                return s;
            }).join('\n');
            alert('共 ' + lines.length + ' 个：\n\n' + preview);
        });
        folderCreateBtn = document.createElement('button');
        folderCreateBtn.textContent = '开始批量创建';
        folderCreateBtn.style.padding = '10px';
        folderCreateBtn.style.backgroundColor = '#ff6a00';
        folderCreateBtn.style.color = 'white';
        folderCreateBtn.style.border = 'none';
        folderCreateBtn.style.borderRadius = '4px';
        folderCreateBtn.style.cursor = 'pointer';
        folderCreateBtn.style.fontWeight = 'bold';
        folderCreateBtn.addEventListener('click', runCreateFolders);
        folderStopBtn = document.createElement('button');
        folderStopBtn.textContent = '停止';
        folderStopBtn.style.padding = '8px';
        folderStopBtn.style.backgroundColor = '#f44336';
        folderStopBtn.style.color = 'white';
        folderStopBtn.style.border = 'none';
        folderStopBtn.style.borderRadius = '4px';
        folderStopBtn.style.cursor = 'pointer';
        folderStopBtn.style.display = 'none';
        folderStopBtn.addEventListener('click', function () { folderStopRequested = true; });
        root.appendChild(prefixLabel);
        root.appendChild(folderPrefixInput);
        root.appendChild(codesLabel);
        root.appendChild(folderCodesInput);
        root.appendChild(previewBtn);
        root.appendChild(folderCreateBtn);
        root.appendChild(folderStopBtn);
    }
    // ==================== EMAIL PROJECT AUTOMATION ====================
    var emailRunning = false;
    var emailDateInput, emailCodeInput, emailStatusEl;
    function setEmailStatus(s) { if (emailStatusEl) emailStatusEl.textContent = s; }
    function getEmailCodeMap() {
        var map = {};
        var raw = getSavedCodes();
        raw.split('\n').forEach(function (line) {
            line = line.trim();
            if (!line) return;
            var code = line, name = '';
            var gt = line.indexOf('>');
            if (gt !== -1) { code = line.slice(0, gt).trim(); name = line.slice(gt + 1).trim().split(/[,，]/)[0].trim(); }
            if (code) map[code] = name;
        });
        return map;
    }
    function computeEmailNames(dateStr, code) {
        var person = getEmailCodeMap()[code] || '';
        return {
            folderName: dateStr + '-' + code,
            projectName: person ? (dateStr + '-' + person + '-' + code) : (dateStr + '-' + code),
            person: person
        };
    }
    async function emailWaitFor(fn, timeout) {
        timeout = timeout || 10000;
        var start = Date.now();
        while (Date.now() - start < timeout) {
            var v = fn();
            if (v) return v;
            await sleepPlain(200);
        }
        return null;
    }
    function emailClickByText(root, texts, sel) {
        sel = sel || 'button, .kol-btn, [class*="btn"], div, span, li, label';
        var els = root.querySelectorAll(sel);
        for (var i = 0; i < els.length; i++) {
            if (!isElementVisible(els[i])) continue;
            var t = (els[i].textContent || '').replace(/\s/g, '');
            for (var j = 0; j < texts.length; j++) {
                if (t === texts[j] || t.indexOf(texts[j]) !== -1) { els[i].click(); return els[i]; }
            }
        }
        return null;
    }
    function emailIsListPage() { return location.href.indexOf('/project-list') !== -1; }
    function emailIsEditPage() { return location.href.indexOf('/detail-edit') !== -1; }
    function emailGetCreateDialog() {
        var ds = document.querySelectorAll('.email-create-edit, .el-dialog__wrapper');
        for (var i = 0; i < ds.length; i++) {
            if (!isElementVisible(ds[i])) continue;
            if (ds[i].querySelector('.project-email')) return ds[i];
            var t = ds[i].textContent || '';
            if (t.indexOf('创建邮件项目') !== -1 && t.indexOf('发件人') !== -1) return ds[i];
        }
        return null;
    }
    function emailSetProjectName(dialog, name) {
        var input = dialog.querySelector('.project-email input') || dialog.querySelector('.el-input__inner');
        if (!input) return false;
        input.focus();
        kwSetter.call(input, name);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    async function emailPickFirstSender(dialog) {
        var trigger = dialog.querySelector('.sender-select-trigger') || dialog.querySelector('.sender-dropdown');
        if (!trigger) return false;
        trigger.click();
        await sleepPlain(700);
        var menu = document.querySelector('.sender-type-panel') || document.querySelector('.el-dropdown-menu.el-popper');
        if (!menu) return false;
        var labels = menu.querySelectorAll('label.el-radio, .el-radio');
        if (labels.length && isElementVisible(labels[0])) { labels[0].click(); return true; }
        return false;
    }
    function emailConfirmCreate(dialog) {
        return emailClickByText(dialog, ['确定', '确认'], '.el-dialog__footer button, .el-dialog__footer .kol-btn, button, .kol-btn');
    }
    async function emailCreateProject(names) {
        var massBtn = null;
        var scoped = document.querySelector('.email-header .btn-group .kol-btn.primary');
        if (scoped && isElementVisible(scoped) && (scoped.textContent || '').indexOf('群发邮件') !== -1) massBtn = scoped;
        if (!massBtn) {
            var all = document.querySelectorAll('.kol-btn.primary, .kol-btn, button, [class*="btn"]');
            for (var i = 0; i < all.length; i++) {
                var t = (all[i].textContent || '').replace(/\s/g, '');
                if (t.indexOf('群发邮件') !== -1 && isElementVisible(all[i])) { massBtn = all[i]; break; }
            }
        }
        if (!massBtn) return { ok: false, reason: '找不到"群发邮件"按钮' };
        massBtn.click();
        await sleepPlain(800);
        var dialog = await emailWaitFor(emailGetCreateDialog, 12000);
        if (!dialog) return { ok: false, reason: '创建弹窗没出现' };
        await sleepPlain(500);
        if (!emailSetProjectName(dialog, names.projectName)) return { ok: false, reason: '找不到项目名输入框' };
        await sleepPlain(400);
        var senderOk = await emailPickFirstSender(dialog);
        await sleepPlain(500);
        if (!emailConfirmCreate(dialog)) return { ok: false, reason: '找不到确定按钮' };
        return { ok: true, senderOk: senderOk };
    }
    function emailClickAddRecipient() {
        var spans = document.querySelectorAll('.form-item .value, span.value, .detail-header-container span');
        for (var i = 0; i < spans.length; i++) {
            var el = spans[i];
            if (!isElementVisible(el)) continue;
            var txt = (el.textContent || '').replace(/\s/g, '');
            if (txt.indexOf('添加收件人') !== -1 && txt.indexOf('添加抄送') === -1) {
                var icon = el.querySelector('.kol-icon-add-circle, i.kolicon');
                (icon || el).click();
                return true;
            }
        }
        return false;
    }
    function emailGetSourceDialog() {
        var ds = document.querySelectorAll('.email-recipient-dialogs, .el-dialog__wrapper');
        for (var i = 0; i < ds.length; i++) {
            if (isElementVisible(ds[i]) && ds[i].querySelector('.option-list')) return ds[i];
        }
        return null;
    }
    function emailClickFolderSource(dialog) {
        var items = dialog.querySelectorAll('.option-list .option-item');
        for (var i = 0; i < items.length; i++) {
            if ((items[i].textContent || '').indexOf('收藏夹') !== -1 && isElementVisible(items[i])) { items[i].click(); return true; }
        }
        if (items.length && isElementVisible(items[0])) { items[0].click(); return true; }
        return false;
    }
    function emailGetFolderPanel() {
        var ds = document.querySelectorAll('.email-recipient-dialogs, .el-dialog__wrapper, [class*="dialog"]');
        for (var i = 0; i < ds.length; i++) {
            if (isElementVisible(ds[i]) && (ds[i].textContent || '').indexOf('一键添加') !== -1) return ds[i];
        }
        return null;
    }
    async function emailPickFolderInPanel(panel, folderName) {
        var select = panel.querySelector('.resource-add-header .el-select') || panel.querySelector('.el-select');
        if (select) { select.click(); await sleepPlain(1000); }
        var want = folderName.trim();
        function getDropdown() {
            return document.querySelector('.simple-resource-list .el-scrollbar__wrap') ||
                   document.querySelector('.simple-resource-list') ||
                   document.querySelector('.el-select-dropdown .el-scrollbar__wrap');
        }
        function findItem() {
            var items = document.querySelectorAll('.simple-resource-list .el-select-dropdown__item, .el-select-dropdown__item.option-item, .el-select-dropdown__item');
            for (var i = 0; i < items.length; i++) {
                if ((items[i].textContent || '').trim() === want && isElementVisible(items[i])) return items[i];
            }
            return null;
        }
        var scroller = getDropdown();
        var lastScrollTop = -1;
        for (var attempt = 0; attempt < 40; attempt++) {
            var hit = findItem();
            if (hit) { hit.click(); return true; }
            scroller = scroller || getDropdown();
            if (scroller) {
                scroller.scrollTop = scroller.scrollTop + 300;
                if (scroller.scrollTop === lastScrollTop) await sleepPlain(500);
                lastScrollTop = scroller.scrollTop;
            }
            await sleepPlain(400);
        }
        return false;
    }
    function emailClickOneKeyAdd(panel) {
        var btns = panel.querySelectorAll('.table-footer button, .left-option button, button, .kol-btn');
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (!isElementVisible(b)) continue;
            if (b.disabled || b.classList.contains('disabled-btn') || b.classList.contains('is-disabled')) continue;
            var t = (b.textContent || '').replace(/\s/g, '');
            if (t.indexOf('一键添加') !== -1) { b.click(); return true; }
        }
        return false;
    }
    async function emailAddRecipients(names) {
        if (!emailGetFolderPanel()) {
            if (!emailGetSourceDialog()) {
                if (!emailClickAddRecipient()) return { ok: false, reason: '找不到"添加收件人"' };
                await sleepPlain(1500);
            }
            var src = await emailWaitFor(emailGetSourceDialog, 8000);
            if (!src) return { ok: false, reason: '收件人来源弹窗没出现' };
            await sleepPlain(400);
            if (!emailClickFolderSource(src)) return { ok: false, reason: '找不到"收藏夹"入口' };
            await sleepPlain(1500);
        }
        var panel = await emailWaitFor(emailGetFolderPanel, 8000);
        if (!panel) return { ok: false, reason: '收藏夹面板没出现' };
        var picked = await emailPickFolderInPanel(panel, names.folderName);
        if (!picked) return { ok: false, reason: '收藏夹下拉里没找到"' + names.folderName + '"' };
        await sleepPlain(1500);
        var platforms = panel.querySelectorAll('.switch-operation .switch-item');
        if (!platforms.length) platforms = document.querySelectorAll('.switch-operation .switch-item');
        if (platforms.length) {
            for (var p = 0; p < platforms.length; p++) {
                var acc = platforms[p].querySelector('.account');
                var count = acc ? parseInt((acc.textContent || '0').replace(/[^0-9]/g, ''), 10) : 0;
                if (count > 0) {
                    platforms[p].click();
                    await sleepPlain(1500);
                    break;
                }
            }
        }
        if (!emailClickOneKeyAdd(panel)) return { ok: false, reason: '找不到可点的"一键添加"（可能收藏夹为空）' };
        return { ok: true };
    }
    async function runEmailFlow(dateStr, code) {
        if (emailRunning) return;
        try { localStorage.setItem('nox-folder-prefix', dateStr); } catch (e) {}
        try { localStorage.setItem('nox-email-code', code); } catch (e) {}
        emailRunning = true;
        setEmailStatus('运行中…');
        try {
            var names = computeEmailNames(dateStr, code);
            if (emailIsListPage()) {
                setEmailStatus('建项目 ' + names.projectName + ' …');
                var r1 = await emailCreateProject(names);
                if (!r1.ok) { alert('建项目失败：' + r1.reason); return; }
                setEmailStatus('等待进入编辑页…');
                var arrived = await emailWaitFor(function () { return emailIsEditPage() ? true : null; }, 12000);
                if (!arrived) { alert('项目已建，但没自动跳转编辑页。进入该项目后再点一次按钮即可加收件人。'); return; }
                await sleepPlain(1500);
            }
            if (emailIsEditPage()) {
                setEmailStatus('添加收件人：' + names.folderName + ' …');
                var r2 = await emailAddRecipients(names);
                if (!r2.ok) { alert('加收件人失败：' + r2.reason); return; }
                setEmailStatus('✅ 完成：' + names.projectName + ' / ' + names.folderName);
            } else {
                alert('当前不在列表页也不在编辑页，请到"邮件邀约"页。');
            }
        } catch (e) {
            alert('出错：' + (e && e.message));
        } finally {
            emailRunning = false;
        }
    }
    function computeNextDayMidnight(dateStr) {
        var mmdd = (dateStr || '').replace(/[^0-9]/g, '');
        if (mmdd.length < 3) return null;
        var mm, dd;
        if (mmdd.length === 3) { mm = mmdd.slice(0, 1); dd = mmdd.slice(1); }
        else { mm = mmdd.slice(0, 2); dd = mmdd.slice(2, 4); }
        var year = new Date().getFullYear();
        var d = new Date(year, parseInt(mm, 10) - 1, parseInt(dd, 10), 0, 0, 0);
        d.setDate(d.getDate() + 1);
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' 00:00:00';
    }
    function getScheduleDialog() {
        var ds = document.querySelectorAll('.set-time-send, .el-dialog__wrapper');
        for (var i = 0; i < ds.length; i++) {
            if (isElementVisible(ds[i]) && (ds[i].textContent || '').indexOf('发送时间') !== -1) return ds[i];
        }
        return null;
    }
    async function runScheduleSend(dateStr) {
        var when = computeNextDayMidnight(dateStr);
        if (!when) { alert('日期前缀无效，无法计算发送时间'); return; }
        var setBtn = null;
        var btns = document.querySelectorAll('.set-time, .kol-btn, [class*="btn"]');
        for (var i = 0; i < btns.length; i++) {
            if ((btns[i].textContent || '').replace(/\s/g, '').indexOf('设置定时') !== -1 && isElementVisible(btns[i])) { setBtn = btns[i]; break; }
        }
        if (!setBtn) { alert('找不到"设置定时"按钮'); return; }
        setBtn.click();
        await sleepPlain(800);
        var dialog = await emailWaitFor(getScheduleDialog, 6000);
        if (!dialog) { alert('设置定时弹窗没出现'); return; }
        var input = dialog.querySelector('.date-time-select input') || dialog.querySelector('.el-date-editor input') || dialog.querySelector('input.el-input__inner');
        if (!input) { alert('找不到发送时间输入框'); return; }
        input.focus();
        input.click();
        await sleepPlain(400);
        kwSetter.call(input, when);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await sleepPlain(300);
        ['keydown', 'keyup'].forEach(function (t) {
            input.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        });
        await sleepPlain(600);
        input.dispatchEvent(new Event('blur', { bubbles: true }));
        await sleepPlain(400);
        var okBtn = null;
        var footerBtns = dialog.querySelectorAll('.dialog-footer .kol-btn, .el-dialog__footer .kol-btn, .kol-btn, button');
        for (var j = 0; j < footerBtns.length; j++) {
            if (!isElementVisible(footerBtns[j])) continue;
            var t = (footerBtns[j].textContent || '').replace(/\s/g, '');
            if (t === '确定' || t === '确认') { okBtn = footerBtns[j]; break; }
        }
        if (!okBtn) { alert('填好了时间 ' + when + '，但没找到弹窗"确定"，请手动点。'); return; }
        okBtn.click();
        setEmailStatus('⏰ 已设定时：' + when + '，等待发送确认…');
        var diagBtn = null;
        var startWait = Date.now();
        while (Date.now() - startWait < 20000) {
            var cand = document.querySelectorAll('.email-send-quota .kol-btn, .dialog-footer button, .el-dialog__footer button, button, .kol-btn');
            for (var d = 0; d < cand.length; d++) {
                if (!isElementVisible(cand[d])) continue;
                var tt = (cand[d].textContent || '').replace(/\s/g, '');
                if (tt.indexOf('忽略继续发送') !== -1 || tt.indexOf('继续发送') !== -1) { diagBtn = cand[d]; break; }
            }
            if (diagBtn) break;
            await sleepPlain(500);
        }
        if (!diagBtn) {
            setEmailStatus('⏰ 已设定时 ' + when + '。发送确认框未出现，请手动点"忽略继续发送"。');
            return;
        }
        await sleepPlain(300);
        diagBtn.click();
        setEmailStatus('✅ 已定时发送：' + when);
    }
    function buildEmailPanel(root) {
        root.style.width = '230px';
        var dLbl = document.createElement('span');
        dLbl.textContent = '日期前缀:';
        dLbl.style.cssText = 'font-size:12px;font-weight:bold;';
        emailDateInput = document.createElement('input');
        emailDateInput.type = 'text';
        emailDateInput.placeholder = '例如 0720';
        emailDateInput.style.cssText = 'padding:6px;border:1px solid #ccc;border-radius:4px;';
        try { emailDateInput.value = localStorage.getItem('nox-folder-prefix') || ''; } catch (e) {}
        emailDateInput.addEventListener('input', function () {
            try { localStorage.setItem('nox-folder-prefix', emailDateInput.value); } catch (e) {}
        });
        var cLbl = document.createElement('span');
        cLbl.textContent = '编号 (查表得人名):';
        cLbl.style.cssText = 'font-size:12px;font-weight:bold;';
        emailCodeInput = document.createElement('input');
        emailCodeInput.type = 'text';
        emailCodeInput.placeholder = '例如 1 或 m-K1';
        emailCodeInput.style.cssText = 'padding:6px;border:1px solid #ccc;border-radius:4px;';
        try { emailCodeInput.value = localStorage.getItem('nox-email-code') || ''; } catch (e) {}
        emailCodeInput.addEventListener('input', function () {
            try { localStorage.setItem('nox-email-code', emailCodeInput.value); } catch (e) {}
        });
        var prev = document.createElement('button');
        prev.textContent = '预览项目名/收藏夹名';
        prev.style.cssText = 'padding:6px;background:#607d8b;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;';
        prev.addEventListener('click', function () {
            var d = (emailDateInput.value || '').trim(), c = (emailCodeInput.value || '').trim();
            if (!d || !c) { alert('请填日期和编号'); return; }
            var n = computeEmailNames(d, c);
            alert('项目名: ' + n.projectName + '\n收藏夹名: ' + n.folderName + '\n人名: ' + (n.person || '无(用编号)'));
        });
        var runBtn = document.createElement('button');
        runBtn.textContent = '🚀 一键：建项目+加收件人';
        runBtn.style.cssText = 'padding:11px;background:#ff6a00;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:13px;';
        runBtn.addEventListener('click', function () {
            var d = (emailDateInput.value || '').trim(), c = (emailCodeInput.value || '').trim();
            if (!d || !c) { alert('请填日期和编号'); return; }
            runEmailFlow(d, c);
        });
        var schedBtn = document.createElement('button');
        schedBtn.textContent = '⏰ 设置次日零点定时';
        schedBtn.style.cssText = 'padding:9px;background:#8e44ad;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:12px;';
        schedBtn.addEventListener('click', function () {
            var d = (emailDateInput.value || '').trim();
            if (!d) { alert('请先填日期前缀'); return; }
            runScheduleSend(d);
        });
        emailStatusEl = document.createElement('div');
        emailStatusEl.style.cssText = 'font-size:11px;color:#4CAF50;text-align:center;min-height:14px;';
        var hint = document.createElement('div');
        hint.style.cssText = 'font-size:11px;color:#888;line-height:1.4;';
        hint.textContent = '编号列表与"创建收藏夹"共用，改一处即可。在列表页点一次跑完；若没跳转，进项目后再点一次接着加收件人。';
        root.appendChild(dLbl); root.appendChild(emailDateInput);
        root.appendChild(cLbl); root.appendChild(emailCodeInput);
        root.appendChild(prev);
        root.appendChild(runBtn);
        root.appendChild(schedBtn);
        root.appendChild(emailStatusEl);
        root.appendChild(hint);
    }
    // ==================== CRM PAGE: filter 建联中 + select-all across pages ====================
    var crmRunning = false, crmStop = false, crmTotal = 0, crmLimit = 1000;
    var crmStartBtn, crmStopBtn, crmLimitInput, crmStatusEl;
    // 按可见文字找元素：只返回“叶子级”命中（即候选元素内部不再包含另一个同样精确匹配的候选），
    // 这样点击的一定是真正绑定了点击事件的最内层节点，而不是外层的包裹 div/span。
    // 之前的版本用 children.length<=2 这种启发式来避免命中外层容器，但像 Nox 页面里
    // “<div class="search-filter-wrap"><div class="kol-btn filter-btn">...高级筛选</div></div>”
    // 这种结构外层只包了一个按钮，children.length===1，会被误判成“叶子”，先被点击，
    // 导致真正绑定 @click 的内层 .kol-btn 从未被点到（事件冒泡只会向上，不会向下传导）。
    function findByText(text, tags) {
        tags = tags || ['button', 'span', 'div', 'li', 'a', 'label'];
        var sel = tags.join(',');
        var nodes = document.querySelectorAll(sel);
        function collect(matchFn) {
            var candidates = [];
            for (var i = 0; i < nodes.length; i++) {
                var el = nodes[i];
                if (!isElementVisible(el)) continue;
                var txt = (el.textContent || '').trim();
                if (matchFn(txt)) candidates.push(el);
            }
            // 只保留叶子级:一个候选如果内部包含另一个候选,就把它自己排除(它是外层容器)
            var leaves = candidates.filter(function (el) {
                for (var j = 0; j < candidates.length; j++) {
                    if (candidates[j] !== el && el.contains(candidates[j])) return false;
                }
                return true;
            });
            return leaves.length ? leaves[0] : null;
        }
        // 第一轮:精确匹配
        var exact = collect(function (txt) { return txt === text; });
        if (exact) return exact;
        // 第二轮:放宽为包含
        var loose = collect(function (txt) { return txt.indexOf(text) !== -1; });
        return loose;
    }
    function clickReal(el) {
        if (!el) return false;
        ['mousedown', 'mouseup', 'click'].forEach(function (t) {
            el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
        });
        return true;
    }
    function setCrmStatus(t) { if (crmStatusEl) crmStatusEl.textContent = t; console.log('[CRM] ' + t); }
    function getCrmSelectAll() {
        var head = document.querySelector('thead .el-checkbox__input, .el-table__header .el-checkbox__input');
        if (head && isElementVisible(head)) return head;
        var all = document.querySelectorAll('.el-checkbox__input');
        for (var i = 0; i < all.length; i++) { if (isElementVisible(all[i])) return all[i]; }
        return null;
    }
    function countCrmChecked() {
        return document.querySelectorAll('.el-table__body .el-checkbox__input.is-checked, tbody .el-checkbox__input.is-checked').length;
    }
    // 读取网站顶部那个权威计数“已选500个网红”。这是跨页累计的真实值,
    // 比自己一页页累加可靠得多(el-table 有固定列时每行 DOM 会渲染两遍,自己数会翻倍)。
    // 读不到就返回 null,让调用方回退到旧的累加逻辑。
    function readCrmSelectedCount() {
        var nodes = document.querySelectorAll('span, div, b, em, strong');
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            // 只看没有子元素的叶子节点,避免把父容器的一大段文字也匹配进来
            if (el.children && el.children.length > 0) continue;
            var m = (el.textContent || '').match(/已选\s*(\d+)\s*个网红/);
            if (m) return parseInt(m[1], 10);
        }
        // 兜底:整页文本里搜一次(某些主题会把数字拆进子 span)
        var m2 = (document.body.innerText || '').match(/已选\s*(\d+)\s*个网红/);
        return m2 ? parseInt(m2[1], 10) : null;
    }
    // 当前表格里有多少数据行(用来判断筛选后是否为空)。排除空态占位行。
    function countCrmRows() {
        var rows = document.querySelectorAll('.el-table__body-wrapper tbody tr.el-table__row');
        if (rows.length) return rows.length;
        return document.querySelectorAll('.el-table__body-wrapper tbody tr').length;
    }
    // 等待某个条件成立(用于替代“点了就假设生效”的写法),避免筛选面板/下拉还没渲染完就点确定
    async function waitUntil(fn, timeout, interval) {
        timeout = timeout || 8000; interval = interval || 300;
        var start = Date.now();
        while (Date.now() - start < timeout) {
            if (crmStop) throw new Error('stopped');
            var v = fn();
            if (v) return v;
            await sleep(interval);
        }
        return null;
    }
    // 找到"团队联系状态"的复选框下拉面板本身(而不是页面上任何写着同名文字的地方,
    // 比如表格里某一行的状态列也会显示"建联中"这几个字,如果不限定范围很容易点错)。
    // 从截图确认到的真实结构是: .el-select-dropdown.is-multiple.check-select-dropdown.crm-drawer-filter-pop
    // 每个选项是 li.el-select-dropdown__item > div.check-select-option > (span.el_check_box + span.el_check_text)
    // optionText: 期望这个下拉面板里含有的选项文字(比如“建联中”)。
    // 页面上可能同时存在多个多选下拉面板(不同筛选字段各有一个),只靠“可见”会拿到错的那个,
    // 于是后面就在错误的面板里找不到/点错选项。这里要求面板里真的含有目标选项才算命中,
    // 从根上避免“选到别的地方”。传空时退回旧的“第一个可见面板”行为(兼容调用方)。
    function getCheckSelectDropdown(optionText) {
        var ds = document.querySelectorAll('.el-select-dropdown.is-multiple, .check-select-dropdown, [class*="crm-drawer-filter-pop"]');
        var firstVisible = null;
        for (var i = 0; i < ds.length; i++) {
            if (!isElementVisible(ds[i])) continue;
            if (!firstVisible) firstVisible = ds[i];
            if (!optionText) return ds[i];
            if (findCheckOption(ds[i], optionText)) return ds[i];
        }
        return optionText ? null : firstVisible;
    }
    // 在下拉面板范围内(不是全页面)按选项文字找到对应的 li,并返回该 li 内真正可点击的复选框行(div.check-select-option),
    // 避免点到外层 li 或内层文字 span 导致点击目标错位。
    function findCheckOption(dropdown, text) {
        var items = dropdown.querySelectorAll('li.el-select-dropdown__item, .el-select-dropdown__item');
        for (var i = 0; i < items.length; i++) {
            var textSpan = items[i].querySelector('.el_check_text');
            var label = textSpan ? textSpan.textContent.trim() : items[i].textContent.trim();
            if (label === text && isElementVisible(items[i])) {
                return items[i].querySelector('.check-select-option') || items[i];
            }
        }
        return null;
    }
    // 判断“建联中”这类自定义复选项是否已勾选。这个页面不是标准 el-checkbox,选中标记可能出现在
    // li(.selected)、复选框 span(.el_check_box 上的 is-checked/checked/is-active),或框里多出一个对勾图标。
    // 之前只认 .is-checked / li.selected,一旦实际用的是别的类名就会“误判成没勾上”,进而触发二次点击
    // 把已勾选的又切回去,最终筛选为空、选 0 人。这里把常见的几种选中信号都覆盖上。
    function isOptionChecked(optionEl) {
        if (!optionEl) return false;
        var li = optionEl.closest('li') || optionEl;
        // DevTools 确认:选中时 li 加 class="selected",且 .el_check_box 里出现打勾图标 i.kol-icon-checkmark
        if (li.classList.contains('selected')) return true;
        if (li.getAttribute('aria-selected') === 'true') return true;
        if (li.querySelector('.kol-icon-checkmark, .is-checked, .checked, .is-active')) return true;
        var box = li.querySelector('.el_check_box');
        if (box) {
            if (/(^|\s)(is-checked|checked|is-active|active)(\s|$)/i.test(box.className)) return true;
            // 选中时复选框里会多出一个对勾图标(i.kolicon.kol-icon-checkmark / svg / 其它 icon)
            if (box.querySelector('svg, i, .icon, [class*="icon"], [class*="tick"], [class*="check"]')) return true;
        }
        return false;
    }
    // "团队联系状态"只是字段的文字标题,不是可点击的下拉触发器——真正能打开下拉框的是
    // 标题旁边/下方的选择框(el-select 组件,显示"全部"字样)。之前的版本直接点标题文字,
    // 标题上没有绑定任何 Vue 点击事件,所以下拉框永远不会打开,后面所有步骤都会超时失败。
    // 这里改成:先定位标题文字,再往上找到它和选择框共同的父容器,在容器内找真正的
    // .el-select 触发器来点击。逐级往上最多找 5 层,避免因为不确定的 DOM 层级结构而找不到。
    // 高级筛选面板是两列网格,每个字段的下拉框(el-select,显示“全部”)就正好在它标题文字的
    // 正下方。之前用“父容器里第一个 el-select”或“文档顺序上紧跟的 el-select”都不可靠:一旦
    // DOM 顺序或容器嵌套跟视觉排布不一致,就会串到相邻字段(实测点成了左列的“对接人”,弹出的是
    // 邮箱列表)。这里改成照着屏幕坐标来——只认标题正下方、横向对齐、且离得最近的那个 el-select,
    // 从几何位置上杜绝“选到别的地方”。
    function findFilterSelectTrigger(labelText) {
        // 首选:按真实 DOM 结构定位(靠 DevTools 确认过)。每个筛选字段是
        //   div.filter-item > p.filter-name(字段标题) + div.filter-item-check-wrap > div.el-select(真正的触发器)
        // 只要标题文字对上,就在同一个 .filter-item 里取 .el-select,几何位置怎么排都不会串到隔壁字段。
        var names = document.querySelectorAll('p.filter-name, .filter-name');
        for (var n = 0; n < names.length; n++) {
            if ((names[n].textContent || '').trim() !== labelText) continue;
            var item = names[n].closest('.filter-item') || names[n].parentElement;
            if (!item) continue;
            var sel = item.querySelector('.el-select');
            if (sel && isElementVisible(sel)) {
                return sel.querySelector('.el-input__inner') || sel.querySelector('.el-select__tags') || sel;
            }
        }
        // 兜底:老的几何定位(标题正下方、横向对齐、最近的 el-select),以防上面的类名将来变了。
        var label = findByText(labelText, ['span', 'div', 'label', 'p']);
        if (!label) return null;
        var lr = label.getBoundingClientRect();
        var selects = document.querySelectorAll('.el-select');
        var best = null, bestGap = Infinity;
        for (var i = 0; i < selects.length; i++) {
            var s = selects[i];
            if (!isElementVisible(s) || label.contains(s) || s.contains(label)) continue;
            var sr = s.getBoundingClientRect();
            // 必须在标题下方(允许少量重叠余量),且与标题横向有重叠(同一列)
            var below = sr.top >= lr.top - 4;
            var horizontallyAligned = sr.left < lr.right && sr.right > lr.left;
            if (!below || !horizontallyAligned) continue;
            var gap = sr.top - lr.bottom;
            if (gap < -lr.height) continue; // 排除跑到标题上方太多的
            if (gap < bestGap) { bestGap = gap; best = s; }
        }
        if (best) return best.querySelector('.el-input__inner') || best;
        return null;
    }
    // 一次性的筛选流程:高级筛选 → 团队联系状态 → 建联中 → 确定
    async function crmApplyFilter() {
        setCrmStatus('点开 高级筛选…');
        var adv = findByText('高级筛选', ['div', 'span', 'button']);
        if (!clickReal(adv)) { setCrmStatus('找不到 高级筛选按钮'); return false; }
        // 等"团队联系状态"这个筛选字段出现(在筛选面板里,而不是下拉弹窗)
        var panelOpen = await waitUntil(function () { return findByText('团队联系状态', ['span', 'div', 'label', 'li']); }, 6000);
        if (!panelOpen) { setCrmStatus('高级筛选面板没展开,请检查是否已点开'); return false; }
        await sleep(400);
        setCrmStatus('打开 团队联系状态 下拉框…');
        var trigger = await waitUntil(function () { return findFilterSelectTrigger('团队联系状态'); }, 4000);
        if (!trigger) { setCrmStatus('找不到 团队联系状态 的下拉触发器'); return false; }
        clickReal(trigger);
        await sleep(500);
        // 等待"团队联系状态"对应的复选框下拉面板真正打开(靠 class 特征定位,不是靠文字),
        // 这样才能确保下一步点的是弹窗里的选项,而不是页面上表格里同名的状态文字。
        setCrmStatus('等待状态选项面板打开…');
        // 要求面板里真的含有“建联中”这个选项才算命中,避免误认成别的字段的下拉面板
        var dropdown = await waitUntil(function () { return getCheckSelectDropdown('建联中'); }, 6000);
        if (!dropdown) {
            // 有些情况下第一次点击没能触发下拉(比如动画/焦点问题),再点一次触发器重试
            clickReal(trigger);
            await sleep(500);
            dropdown = await waitUntil(function () { return getCheckSelectDropdown('建联中'); }, 4000);
        }
        if (!dropdown) { setCrmStatus('状态下拉面板没出现'); return false; }
        await sleep(300);
        setCrmStatus('选择 建联中…');
        var lianjieOption = await waitUntil(function () { return findCheckOption(dropdown, '建联中'); }, 6000);
        if (!lianjieOption) { setCrmStatus('下拉面板里没找到 建联中选项'); return false; }
        // 关键教训:这个选项是“开关”,点一次勾上、再点一次取消。之前版本会在“选中检测”失灵时盲目补点,
        // 把刚勾上的又切回去,最终筛选为空、选 0 人。而选中后 DOM 到底加什么标记并不确定,检测本身不可靠。
        // 好在下拉面板每次打开都是全空的(起点必为“未选”),所以最稳的做法是:无条件只点一次 = 选中,
        // 之后的检测只用来“判断是否成功并提示”,绝不拿检测结果去决定要不要再点,从根上杜绝反复横跳。
        clickReal(lianjieOption);
        await sleep(600);
        var okChecked = isOptionChecked(findCheckOption(dropdown, '建联中'));
        if (!okChecked) {
            // 检测显示没选中——但检测可能不准。只在“确实还没选中”时补一次,且补完再看一眼;
            // 若两次点击后仍判定未选,大概率是检测识别不了这个页面的选中标记,此时不再强行判定失败,
            // 而是继续走后面的“确定”,由最终结果的行数来说明是否真的筛出了数据。
            clickReal(findCheckOption(dropdown, '建联中'));
            await sleep(600);
            okChecked = isOptionChecked(findCheckOption(dropdown, '建联中'));
            if (!okChecked) {
                // 兜底:把状态恢复成“只点了奇数次=选中”。上面共点了 2 次(=未选),这里再点 1 次凑成 3 次=选中。
                clickReal(findCheckOption(dropdown, '建联中'));
                await sleep(600);
                setCrmStatus('已点选 建联中(选中标记无法确认,以最终筛选结果为准)');
            }
        }
        await sleep(400);
        // 收起下拉面板(再点一次同一个触发器,让下拉收起,避免遮挡确定按钮)
        clickReal(trigger);
        await sleep(500);
        setCrmStatus('点击 确定…');
        var ok = findByText('确定', ['button', 'span', 'div']);
        if (ok) { clickReal(ok); await sleep(2000); }
        else { setCrmStatus('没找到确定按钮,筛选可能未生效'); return false; }
        return true;
    }
    // 设置每页 100 条
    async function crmSetPageSize100() {
        setCrmStatus('设置 100 条/页…');
        var sizeBox = null;
        // DevTools 确认:每页条数是 span.el-pagination__sizes 里的 div.el-select(触发器是里面的 input.el-input__inner,
        // placeholder="请选择")。它显示的“50条/页”是 input 的 value,不是 textContent,所以不能再用文字匹配去找,
        // 必须按结构定位,否则永远找不到、直接跳过。
        var sizesWrap = document.querySelector('.el-pagination__sizes');
        if (sizesWrap) {
            var selInSizes = sizesWrap.querySelector('.el-select');
            if (selInSizes && isElementVisible(selInSizes)) sizeBox = selInSizes;
        }
        if (!sizeBox) {
            // 兜底:老的文字匹配(万一将来结构变了)
            var candidates = document.querySelectorAll('.el-pagination .el-select, .el-pagination__sizes, .el-select');
            for (var i = 0; i < candidates.length; i++) {
                if (/条\/页/.test(candidates[i].textContent) && isElementVisible(candidates[i])) { sizeBox = candidates[i]; break; }
            }
        }
        if (sizeBox) {
            // 点 input 才能把下拉唤出来,直接点外层 div 有时不触发
            var sizeTrigger = sizeBox.querySelector('.el-input__inner') || sizeBox;
            clickReal(sizeTrigger);
            var opened = await waitUntil(function () {
                var items = document.querySelectorAll('.el-select-dropdown__item, li.el-select-dropdown__item');
                for (var k = 0; k < items.length; k++) { if (isElementVisible(items[k])) return true; }
                return false;
            }, 4000);
            if (opened) {
                var items = document.querySelectorAll('.el-select-dropdown__item, li.el-select-dropdown__item');
                for (var j = 0; j < items.length; j++) {
                    var t = items[j].textContent.trim();
                    // 精确匹配 100 那一项(“100条/页”或纯“100”),避免误中 1000 之类
                    if (isElementVisible(items[j]) && (t === '100' || t === '100条/页' || /^100\s*条\/页$/.test(t))) {
                        clickReal(items[j]); await sleep(2000); return true;
                    }
                }
            }
        }
        setCrmStatus('未找到分页设置,跳过(可能已是100)');
        return false;
    }
    // 翻到下一页
    async function crmNextPage() {
        var nextBtn = document.querySelector('.el-pagination button.btn-next');
        if (nextBtn && !nextBtn.disabled && isElementVisible(nextBtn)) {
            clickReal(nextBtn);
            return true;
        }
        return false;
    }
    async function crmWaitTableReady(timeout) {
        timeout = timeout || 15000;
        var start = Date.now();
        while (Date.now() - start < timeout) {
            if (crmStop) throw new Error('stopped');
            var rows = document.querySelectorAll('.el-table__body-wrapper tbody tr, .el-table__row');
            var sa = getCrmSelectAll();
            if (rows.length > 0 && sa) { await sleep(600); return true; }
            await sleep(500);
        }
        return false;
    }
    async function crmStart() {
        if (crmRunning) return;
        var lim = parseInt(crmLimitInput.value, 10);
        if (isNaN(lim) || lim <= 0) { alert('请输入有效的数字'); return; }
        crmLimit = lim; crmRunning = true; crmStop = false; crmTotal = 0;
        crmStartBtn.style.display = 'none'; crmStopBtn.style.display = 'block';
        crmLimitInput.disabled = true;
        var outcome = 'unknown'; // filter_fail / stopped / empty / done,决定最后弹什么提示,避免一律报“成功”
        try {
            var filterOk = await crmApplyFilter();
            // 不要用笼统的“筛选步骤失败”覆盖掉 crmApplyFilter 里那条具体的失败原因,
            // 否则每次都只看到“失败”却不知道卡在哪一步。保留原文,只在末尾追加“已停止”。
            if (!filterOk) {
                var last = crmStatusEl ? crmStatusEl.textContent : '';
                setCrmStatus((last ? last : '筛选步骤失败') + ' — 已停止');
                outcome = 'filter_fail';
                return;
            }
            await crmWaitTableReady();
            await crmSetPageSize100();
            var firstReady = await crmWaitTableReady();
            // 筛选后如果一行都没有,说明“建联中”很可能没真正勾上(或本来就没有建联中的人),
            // 直接如实告知,而不是继续走完再谎报“完成,共选 0 人”。
            if (!firstReady || countCrmRows() === 0) {
                setCrmStatus('筛选后没有数据行,可能“建联中”未选中');
                outcome = 'empty';
                return;
            }
            while (!crmStop && crmTotal < crmLimit) {
                var ready = await crmWaitTableReady();
                if (!ready) { setCrmStatus('表格未就绪,停止'); break; }
                var sa = getCrmSelectAll();
                if (sa && !sa.classList.contains('is-checked')) {
                    clickReal(sa);
                    await sleep(CHECK_DELAY);
                }
                // 优先读网站顶部的权威计数“已选N个网红”(跨页累计的真实值)。
                // 自己一页页累加会翻倍:el-table 有固定列时每行 checkbox 渲染两遍,一页 100 会数成 200。
                var authoritative = readCrmSelectedCount();
                if (authoritative !== null) {
                    crmTotal = authoritative;
                } else {
                    var checked = countCrmChecked();
                    if (checked > 0) { crmTotal += checked; }
                }
                setCrmStatus('已选 ' + crmTotal + ' / ' + crmLimit);
                if (crmTotal >= crmLimit) break;
                var hasNext = await crmNextPage();
                if (!hasNext) { setCrmStatus('已到最后一页'); break; }
                await sleep(NEXT_PAGE_WAIT_TIME);
            }
            outcome = crmStop ? 'stopped' : 'done';
        } catch (e) {
            console.log('[CRM] ' + e.message);
            if (e.message === 'stopped') outcome = 'stopped';
        } finally {
            crmRunning = false;
            crmStartBtn.style.display = 'block'; crmStopBtn.style.display = 'none';
            crmLimitInput.disabled = false;
            if (outcome === 'filter_fail') {
                alert('筛选没成功,一个都没选。请把“团队联系状态”下拉展开的样子截图给我。');
            } else if (outcome === 'empty') {
                alert('筛选“建联中”后没有数据行。可能是没勾上,或当前确实没有建联中的达人。');
            } else if (outcome === 'stopped') {
                setCrmStatus('已停止,共选 ' + crmTotal + ' 人');
                alert('已手动停止,共选 ' + crmTotal + ' 人');
            } else {
                setCrmStatus('完成,共选 ' + crmTotal + ' 人');
                alert('CRM 全选完成,共选 ' + crmTotal + ' 人');
            }
        }
    }
    function buildCrmPanel(root) {
        root.style.width = '210px';
        var desc = document.createElement('span');
        desc.innerHTML = '建联中 · 自动全选<br><span style="font-weight:normal;color:#888;font-size:11px;">筛选建联中→100条/页→逐页全选</span>';
        desc.style.fontSize = '12px';
        desc.style.fontWeight = 'bold';
        var lab = document.createElement('span');
        lab.textContent = '目标数量:';
        lab.style.fontSize = '12px';
        crmLimitInput = document.createElement('input');
        crmLimitInput.type = 'number';
        crmLimitInput.value = '1000';
        crmLimitInput.style.padding = '5px';
        crmLimitInput.style.border = '1px solid #ccc';
        crmLimitInput.style.borderRadius = '4px';
        crmStartBtn = document.createElement('button');
        crmStartBtn.textContent = '开始筛选+全选';
        crmStartBtn.style.padding = '10px';
        crmStartBtn.style.backgroundColor = '#4CAF50';
        crmStartBtn.style.color = 'white';
        crmStartBtn.style.border = 'none';
        crmStartBtn.style.borderRadius = '4px';
        crmStartBtn.style.cursor = 'pointer';
        crmStartBtn.style.fontWeight = 'bold';
        crmStartBtn.addEventListener('click', crmStart);
        crmStopBtn = document.createElement('button');
        crmStopBtn.textContent = 'Stop';
        crmStopBtn.style.padding = '8px';
        crmStopBtn.style.backgroundColor = '#f44336';
        crmStopBtn.style.color = 'white';
        crmStopBtn.style.border = 'none';
        crmStopBtn.style.borderRadius = '4px';
        crmStopBtn.style.cursor = 'pointer';
        crmStopBtn.style.display = 'none';
        crmStopBtn.addEventListener('click', function () { crmStop = true; });
        crmStatusEl = document.createElement('div');
        crmStatusEl.style.fontSize = '11px';
        crmStatusEl.style.color = '#555';
        crmStatusEl.style.marginTop = '4px';
        crmStatusEl.textContent = '就绪';
        root.appendChild(desc);
        root.appendChild(lab);
        root.appendChild(crmLimitInput);
        root.appendChild(crmStartBtn);
        root.appendChild(crmStopBtn);
        root.appendChild(crmStatusEl);
    }
    function ensureUI() {
        if (!isPanelPage()) return; // 非功能页不建面板
        if (document.body) { initializeControls(); }
        else { setTimeout(ensureUI, 500); }
    }
    // 页面加载后,若有进行中的全自动任务,自动续跑(只在搜索页)。延迟等页面渲染。
    // 区分两种情况:
    //  - 任务进行中的正常重载(翻页/跳新词URL):状态是刚存的(60秒内)→ 无声续跑
    //  - 旧的残留状态(关了浏览器过一阵、或上次没停干净):状态陈旧 → 先弹确认,别闷头自己跑
    function ultraAutoResume() {
        var st = ultraLoadState();
        if (!st || !st.running) return;
        // 收藏夹/邮件邀请/CRM 页:用户是主动切过去干活的,别把人跳回搜索页打断。
        // 这些页面不触发自动恢复(任务状态仍保留,回到搜索页或首页时再续)。
        if (isFolderPage() || isEmailPage() || isCrmPage()) {
            return;
        }
        // 被人机验证/意外跳转甩到了非搜索结果页(首页等):任务状态还在,只是页面不对。
        // 显示倒计时提示条,自动跳回该批词应在的搜索 URL 续跑。
        if (!isSearchResultPage()) {
            ultraShowRecoveryBar(st);
            return;
        }
        var age = Date.now() - (st._ts || 0);
        if (age <= 60000) {
            // 新鲜:任务正在跑的正常重载,直接续
            setTimeout(function () { ultraTick(); }, 2000);
        } else {
            // 陈旧:问用户要不要继续,不要一刷新就自动收藏
            setTimeout(function () {
                var msg = '检测到一个未完成的全自动任务(已收藏 ' + (st.stats ? st.stats.collected : 0) + ' 个)。\n\n点“确定”继续跑,点“取消”结束并清理。';
                if (confirm(msg)) {
                    ultraSaveState(st); // 刷新时间戳
                    ultraTick();
                } else {
                    stopUltra();
                    ultraStatus('已结束上次的残留任务。');
                }
            }, 1500);
        }
    }
    // 被甩出搜索页时的恢复提示条:倒计时后自动跳回该批词的搜索 URL。可点“留在本页”取消。
    function ultraShowRecoveryBar(st) {
        if (document.getElementById('nox-ultra-recovery')) return;
        var targetUrl;
        try { targetUrl = ultraBuildUrl(st.template, st.batchWords, st.platform); }
        catch (e) { console.log('[ultra] 重建续跑URL失败:', e && e.message); return; }
        var secs = 5, cancelled = false;
        var bar = document.createElement('div');
        bar.id = 'nox-ultra-recovery';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#7c3aed;color:#fff;padding:12px 16px;font-size:14px;font-weight:bold;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3);';
        var span = document.createElement('span');
        var btnGo = document.createElement('button');
        btnGo.textContent = '立即继续';
        btnGo.style.cssText = 'margin-left:12px;padding:4px 10px;background:#fff;color:#7c3aed;border:none;border-radius:4px;cursor:pointer;font-weight:bold;';
        btnGo.addEventListener('click', function () { cancelled = true; location.href = targetUrl; });
        var btnStay = document.createElement('button');
        btnStay.textContent = '留在本页';
        btnStay.style.cssText = 'margin-left:8px;padding:4px 10px;background:transparent;color:#fff;border:1px solid #fff;border-radius:4px;cursor:pointer;';
        btnStay.addEventListener('click', function () { cancelled = true; bar.remove(); });
        function render() {
            span.textContent = '⚠️ 全自动任务被中断(已收藏 ' + (st.stats ? st.stats.collected : 0) + ' 个)。' + secs + ' 秒后自动跳回继续…';
        }
        render();
        bar.appendChild(span); bar.appendChild(btnGo); bar.appendChild(btnStay);
        (document.body || document.documentElement).appendChild(bar);
        var timer = setInterval(function () {
            if (cancelled) { clearInterval(timer); return; }
            secs--;
            if (secs <= 0) { clearInterval(timer); location.href = targetUrl; return; }
            render();
        }, 1000);
    }
    setInterval(function () {
        if (!document.body) return;
        var existing = document.getElementById('nox-script-ui');
        // 非功能页(首页等):不建面板,已有的也移除
        if (!isPanelPage()) { if (existing) existing.remove(); return; }
        if (!existing) { initializeControls(); return; }
        var want = currentPageType();
        if (existing.getAttribute('data-page') !== want && !folderRunning && !isScriptRunning && !emailRunning && !crmRunning) {
            existing.remove();
            initializeControls();
        }
    }, 1500);
    ensureUI();
    ultraAutoResume();
})();
