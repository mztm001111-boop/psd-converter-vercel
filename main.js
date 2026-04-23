/**
 * PSD 批量转换 JPG/PNG —— 主逻辑
 * 功能：
 *  - 拖拽 / 选择上传 PSD 文件
 *  - 使用 ag-psd 在浏览器端解析 PSD
 *  - 渲染到 Canvas，按参数（质量、最大边长、背景色）输出为 JPG 或 PNG
 *  - 支持三种保存方式：
 *      1) File System Access API 写入指定目录（Chrome/Edge）
 *      2) 打包成 ZIP 下载（支持自动分卷）
 *      3) 逐个下载
 */

// ============== 状态管理 ==============
const state = {
    tasks: [],              // { id, file, name, status, progress, error, thumbUrl, jpgBlob, outName }
    directoryHandle: null,  // 用户选择的保存目录句柄
    converting: false
};

// ============== DOM 引用 ==============
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const fileInput        = $('#fileInput');
const dropZone         = $('#dropZone');
const fileCountBadge   = $('#fileCountBadge');
const taskListEl       = $('#taskList');
const emptyTip         = $('#emptyTip');
const clearBtn         = $('#clearBtn');

const qualityRange     = $('#qualityRange');
const qualityValue     = $('#qualityValue');
// 输出尺寸模式（3 选 1）
const resizeModeRadios = document.querySelectorAll('input[name="resizeMode"]');
const maxSizeInput     = $('#maxSizeInput');
const maxSidePresetsEl = $('#maxSidePresets');
const targetWInput     = $('#targetWInput');
const targetHInput     = $('#targetHInput');
const fitModeSel       = $('#fitMode');
const bgColorInput     = $('#bgColor');
const bgColorText      = $('#bgColorText');
const prefixInput      = $('#prefix');

const pickDirBtn       = $('#pickDirBtn');
const dirInfo          = $('#dirInfo');
const dirNameEl        = $('#dirName');

const convertBtn       = $('#convertBtn');
const overallProgressWrap = $('#overallProgressWrap');
const overallProgressBar  = $('#overallProgressBar');
const overallProgressText = $('#overallProgressText');

const toastEl = $('#toast');

// 批次评估面板
const batchStatsEl   = $('#batchStats');
const batchCountEl   = $('#batchCount');
const batchTotalEl   = $('#batchTotalSize');
const batchMaxEl     = $('#batchMaxSize');
const batchLimitEl   = $('#batchLimit');
const batchLevelEl   = $('#batchLevelBadge');
const batchTipEl     = $('#batchTip');

// 转换参数总开关
const paramToggle     = $('#paramToggle');
const paramToggleText = $('#paramToggleText');
const paramMask       = $('#paramMask');

// ZIP 分卷设置
const zipSplitSizeSel = $('#zipSplitSize');
const zipSplitWrap    = $('#zipSplitWrap');

// 输出格式
const formatRadios    = document.querySelectorAll('input[name="outputFormat"]');
const formatHintEl    = $('#formatHint');
const formatDescEl    = $('#formatDesc');

// ============== 默认参数（开关关闭时使用） ==============
const DEFAULT_PARAMS = {
    quality:    0.95,
    resizeMode: 'original',
    maxSize:    0,
    targetW:    0,
    targetH:    0,
    fitMode:    'contain',
    bgColor:    '#ffffff',
    prefix:     ''
};

function getResizeMode() {
    const checked = document.querySelector('input[name="resizeMode"]:checked');
    return checked ? checked.value : 'original';
}

/** 获取当前生效的转换参数（根据开关状态） */
function getEffectiveParams() {
    if (paramToggle && paramToggle.checked) {
        const resizeMode = getResizeMode();
        return {
            quality:    parseFloat(qualityRange.value) || 0.92,
            resizeMode,
            maxSize:    resizeMode === 'maxSide' ? (parseInt(maxSizeInput && maxSizeInput.value, 10) || 0) : 0,
            targetW:    resizeMode === 'wh' ? (parseInt(targetWInput && targetWInput.value, 10) || 0) : 0,
            targetH:    resizeMode === 'wh' ? (parseInt(targetHInput && targetHInput.value, 10) || 0) : 0,
            fitMode:    (fitModeSel && fitModeSel.value) || 'contain',
            bgColor:    bgColorInput.value || '#ffffff',
            prefix:     (prefixInput.value || '').trim()
        };
    }
    return { ...DEFAULT_PARAMS };
}

// ============== 批次容量限制规则 ==============
/**
 * 各保存模式下的软上限（经验值）
 *  - 文件数量建议上限
 *  - 总体积建议上限（字节）
 *  - 单文件警戒值（字节）
 */
const BATCH_LIMITS = {
    directory: { maxCount: 500, maxTotal: 4  * 1024 * 1024 * 1024, singleWarn: 500 * 1024 * 1024 }, // 4GB
    zip:       { maxCount: 100, maxTotal: 2  * 1024 * 1024 * 1024, singleWarn: 300 * 1024 * 1024 }, // 2GB
    each:      { maxCount: 200, maxTotal: 3  * 1024 * 1024 * 1024, singleWarn: 400 * 1024 * 1024 }  // 3GB
};
/** 硬上限（无论如何超过就强烈阻止） */
const HARD_MAX_COUNT = 2000;

// ============== 工具函数 ==============

/** 生成唯一 ID */
function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 格式化文件大小 */
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** Toast 提示 */
let toastTimer = null;
function toast(msg, type = 'info') {
    clearTimeout(toastTimer);
    toastEl.textContent = msg;
    toastEl.className = `fixed top-6 right-6 z-50 px-5 py-3 rounded-xl shadow-lg text-sm font-medium text-white transition-all toast-${type}`;
    toastEl.style.opacity = '0';
    toastEl.style.transform = 'translateY(-10px)';
    toastEl.classList.remove('hidden');
    requestAnimationFrame(() => {
        toastEl.style.opacity = '1';
        toastEl.style.transform = 'translateY(0)';
    });
    toastTimer = setTimeout(() => {
        toastEl.style.opacity = '0';
        toastEl.style.transform = 'translateY(-10px)';
        setTimeout(() => toastEl.classList.add('hidden'), 300);
    }, 2800);
}

/** 获取当前保存模式 */
function getSaveMode() {
    const checked = document.querySelector('input[name="saveMode"]:checked');
    return checked ? checked.value : 'zip';
}

/** 获取当前输出格式：'jpg' | 'png' */
function getOutputFormat() {
    const checked = document.querySelector('input[name="outputFormat"]:checked');
    return checked ? checked.value : 'jpg';
}

/** 生成输出文件名（参数关闭时不加前缀） */
function buildOutputName(srcName) {
    const { prefix } = getEffectiveParams();
    // 剥离所有支持的输入格式扩展名
    const base = srcName.replace(/\.(psd|png|jpe?g|webp|gif|bmp|tiff?|ico)$/i, '');
    const ext  = getOutputFormat() === 'png' ? 'png' : 'jpg';
    return `${prefix}${base}.${ext}`;
}

// ============== 批次评估 ==============

/**
 * 根据当前任务列表 + 保存模式，计算批次健康度
 * @returns {{level:'safe'|'warn'|'danger', count, totalSize, maxSize, limit, tip}}
 */
function evaluateBatch() {
    const mode = getSaveMode();
    const limit = BATCH_LIMITS[mode] || BATCH_LIMITS.zip;
    const count = state.tasks.length;
    let totalSize = 0;
    let maxSize = 0;
    state.tasks.forEach(t => {
        totalSize += t.file.size;
        if (t.file.size > maxSize) maxSize = t.file.size;
    });

    let level = 'safe';
    const reasons = [];

    // 硬上限
    if (count > HARD_MAX_COUNT) {
        level = 'danger';
        reasons.push(`文件数 ${count} 超过硬上限 ${HARD_MAX_COUNT}，浏览器极可能崩溃，强烈建议分批处理`);
    } else if (count > limit.maxCount) {
        level = 'danger';
        reasons.push(`文件数 ${count} 超过当前模式建议上限 ${limit.maxCount}，建议拆成多批`);
    } else if (count > limit.maxCount * 0.75) {
        level = level === 'danger' ? 'danger' : 'warn';
        reasons.push(`文件数接近建议上限（${limit.maxCount}）`);
    }

    if (totalSize > limit.maxTotal) {
        level = 'danger';
        reasons.push(`总大小 ${formatSize(totalSize)} 超过 ${formatSize(limit.maxTotal)}，内存压力过大`);
    } else if (totalSize > limit.maxTotal * 0.75) {
        level = level === 'danger' ? 'danger' : 'warn';
        reasons.push(`总大小接近建议上限（${formatSize(limit.maxTotal)}）`);
    }

    if (maxSize > limit.singleWarn) {
        level = level === 'danger' ? 'danger' : 'warn';
        reasons.push(`存在单个文件 ${formatSize(maxSize)}，超过 ${formatSize(limit.singleWarn)}，转换较慢且易 OOM`);
    }

    let tip;
    if (level === 'safe') {
        tip = `当前批次处于安全范围，可直接开始转换。`;
    } else {
        tip = reasons.join('；') + '。';
    }

    return { level, count, totalSize, maxSize, limit: limit.maxCount, tip, mode };
}

/** 更新批次评估 UI */
function updateBatchStats() {
    if (!batchStatsEl) return;
    if (state.tasks.length === 0) {
        batchStatsEl.classList.add('hidden');
        return;
    }
    const r = evaluateBatch();
    batchStatsEl.classList.remove('hidden');
    batchCountEl.textContent = r.count;
    batchTotalEl.textContent = formatSize(r.totalSize);
    batchMaxEl.textContent   = r.maxSize ? formatSize(r.maxSize) : '—';
    batchLimitEl.textContent = r.limit;

    // 徽章
    const badgeMap = {
        safe:   { cls: 'bg-emerald-100 text-emerald-700', icon: 'fa-circle-check',        text: '安全' },
        warn:   { cls: 'bg-amber-100   text-amber-700',   icon: 'fa-triangle-exclamation', text: '偏大' },
        danger: { cls: 'bg-rose-100    text-rose-700',    icon: 'fa-circle-exclamation',   text: '超限' }
    };
    const b = badgeMap[r.level];
    batchLevelEl.className = `text-xs px-2.5 py-1 rounded-full font-medium ${b.cls}`;
    batchLevelEl.innerHTML = `<i class="fa-solid ${b.icon} mr-1"></i>${b.text}`;

    // 提示文本
    const tipColor = r.level === 'safe' ? 'text-slate-600'
                   : r.level === 'warn' ? 'text-amber-700'
                   : 'text-rose-700';
    const tipIcon  = r.level === 'safe' ? 'fa-circle-info text-brand-500'
                   : r.level === 'warn' ? 'fa-triangle-exclamation text-amber-500'
                   : 'fa-circle-exclamation text-rose-500';
    batchTipEl.className = `px-4 py-2.5 text-xs bg-white border-t border-slate-200 ${tipColor}`;
    batchTipEl.innerHTML = `<i class="fa-solid ${tipIcon} mr-1"></i>${r.tip}`;
}

// ============== 任务列表渲染 ==============

function updateFileCount() {
    if (fileCountBadge) fileCountBadge.textContent = `${state.tasks.length} 个文件`;
    if (clearBtn)      clearBtn.disabled   = state.tasks.length === 0;
    if (convertBtn)    convertBtn.disabled = state.tasks.length === 0 || state.converting;
    if (emptyTip)      emptyTip.style.display = state.tasks.length === 0 ? '' : 'none';
    updateBatchStats();
}

function statusLabel(status) {
    switch (status) {
        case 'pending':    return { text: '等待中',   cls: 'status-pending',    icon: 'fa-regular fa-clock' };
        case 'processing': return { text: '转换中',   cls: 'status-processing', icon: 'fa-solid fa-spinner spin' };
        case 'success':    return { text: '已完成',   cls: 'status-success',    icon: 'fa-solid fa-circle-check' };
        case 'error':      return { text: '失败',     cls: 'status-error',      icon: 'fa-solid fa-circle-exclamation' };
        case 'saved':      return { text: '已保存',   cls: 'status-success',    icon: 'fa-solid fa-floppy-disk' };
        default:           return { text: status,     cls: 'status-pending',    icon: 'fa-solid fa-circle' };
    }
}

function renderTask(task) {
    const existed = document.getElementById(`task-${task.id}`);
    const { text, cls, icon } = statusLabel(task.status);

    const html = `
        <div id="task-${task.id}" class="task-item px-6 py-4 flex items-center gap-4 hover:bg-slate-50 transition">
            <div class="task-thumb">
                ${task.thumbUrl
                    ? `<img src="${task.thumbUrl}" alt="thumb" />`
                    : `<i class="fa-regular fa-image text-brand-400 text-xl"></i>`}
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                    <p class="text-sm font-medium text-slate-800 truncate" title="${task.name}">${task.name}</p>
                </div>
                <div class="mt-1 flex items-center gap-3 text-xs text-slate-500">
                    <span><i class="fa-regular fa-file mr-1"></i>${formatSize(task.file.size)}</span>
                    ${task.width ? `<span><i class="fa-solid fa-maximize mr-1"></i>${task.width}×${task.height}</span>` : ''}
                    ${task.outSize ? `<span class="text-emerald-600"><i class="fa-solid fa-arrow-right-long mr-1"></i>${formatSize(task.outSize)}</span>` : ''}
                </div>
                ${(task.status === 'processing' || (task.progress > 0 && task.status !== 'success' && task.status !== 'saved'))
                    ? `<div class="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div class="progress-bar h-full bg-gradient-to-r from-brand-500 to-indigo-500 rounded-full" style="width:${task.progress || 0}%"></div>
                       </div>`
                    : ''}
                ${task.error ? `<p class="mt-1.5 text-xs text-rose-600"><i class="fa-solid fa-circle-exclamation mr-1"></i>${task.error}</p>` : ''}
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
                <span class="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full ${cls}">
                    <i class="${icon}"></i>${text}
                </span>
                ${(task.status === 'success' || task.status === 'saved') && task.jpgBlob
                    ? `<button data-action="download" data-id="${task.id}" class="w-8 h-8 rounded-lg bg-brand-50 text-brand-600 hover:bg-brand-100 transition" title="下载">
                          <i class="fa-solid fa-download"></i>
                       </button>`
                    : ((task.status === 'saved' && !task.jpgBlob)
                        ? `<span class="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg bg-emerald-50 text-emerald-600" title="已释放内存，如需再次下载请重新转换">
                              <i class="fa-solid fa-hard-drive"></i>已落盘
                           </span>`
                        : '')}
                <button data-action="remove" data-id="${task.id}" class="w-8 h-8 rounded-lg bg-slate-100 text-slate-500 hover:bg-rose-100 hover:text-rose-600 transition" title="移除">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>
    `;

    if (existed) {
        const wrap = document.createElement('div');
        wrap.innerHTML = html.trim();
        existed.replaceWith(wrap.firstChild);
    } else {
        taskListEl.insertAdjacentHTML('beforeend', html);
    }
}

function renderAll() {
    // 清除非 emptyTip 的内容
    [...taskListEl.children].forEach(ch => {
        if (ch.id !== 'emptyTip') ch.remove();
    });
    state.tasks.forEach(renderTask);
    updateFileCount();
}

// ============== 文件处理 ==============

/** 支持的输入文件扩展名正则 */
const SUPPORTED_EXT_RE = /\.(psd|png|jpe?g|webp|gif|bmp|tiff?|ico)$/i;

/** 从文件名获取输入类型标签：'psd' | 'tiff' | 'ico' | 'image' */
function detectInputKind(file) {
    const name = (file.name || '').toLowerCase();
    if (/\.psd$/i.test(name))        return 'psd';
    if (/\.(tiff?)$/i.test(name))    return 'tiff';
    if (/\.ico$/i.test(name))        return 'ico';
    // 其他常见格式：PNG / JPG / WEBP / GIF / BMP —— 浏览器原生可解码
    if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) return 'image';
    // 兜底：按 mime 判断
    if (file.type && file.type.startsWith('image/')) return 'image';
    return 'unknown';
}

function addFiles(files) {
    const allFiles = [...files];
    const validFiles = allFiles.filter(f => SUPPORTED_EXT_RE.test(f.name));
    const rejected = allFiles.length - validFiles.length;
    if (rejected > 0) {
        toast(`已忽略 ${rejected} 个不支持的文件`, 'warn');
    }
    if (validFiles.length === 0) {
        if (rejected === 0) toast('请选择 PSD / PNG / JPG / WEBP / GIF / BMP / TIFF / ICO 格式的文件', 'warn');
        return;
    }

    // 硬上限保护：避免一次添加过多文件导致页面卡死
    const remaining = HARD_MAX_COUNT - state.tasks.length;
    let accepted = validFiles;
    let truncated = 0;
    if (remaining <= 0) {
        toast(`任务队列已达硬上限 ${HARD_MAX_COUNT} 个，请先清理或完成当前任务`, 'error');
        return;
    }
    if (validFiles.length > remaining) {
        accepted = validFiles.slice(0, remaining);
        truncated = validFiles.length - remaining;
    }

    accepted.forEach(file => {
        state.tasks.push({
            id: uid(),
            file,
            name: file.name,
            kind: detectInputKind(file),   // 记录输入类型，转换时据此分发
            status: 'pending',
            progress: 0,
            error: '',
            thumbUrl: '',
            jpgBlob: null,
            outName: buildOutputName(file.name)
        });
    });
    renderAll();

    if (truncated > 0) {
        toast(`已添加 ${accepted.length} 个文件，${truncated} 个因超出队列上限被忽略`, 'warn');
    } else {
        toast(`已添加 ${accepted.length} 个文件`, 'success');
    }
}

// ============== PSD 转图片核心 ==============

/** 大文件阈值（字节），超过此值会启用额外的内存优化策略 */
const LARGE_FILE_THRESHOLD = 300 * 1024 * 1024;       // 300MB：启用降级策略
const HUGE_FILE_THRESHOLD  = 800 * 1024 * 1024;       // 800MB：强制最保守策略
/** ArrayBuffer 理论上限（V8）：约 2GB - 1 字节 */
const ARRAY_BUFFER_SAFE_MAX = 2040 * 1024 * 1024;     // 2040MB 作为安全阈值
/** 画布最大边长（超大尺寸强制降采样到此值以内，避免 canvas OOM） */
const SAFE_CANVAS_MAX_DIM = 8192;                     // 浏览器画布安全边长
/** 大文件场景下画布最大边长（更激进的降采样） */
const LARGE_FILE_CANVAS_MAX_DIM = 4096;

/** 让出主线程，给 GC/UI 一个喘息的机会 */
function yieldToBrowser(ms = 0) {
    return new Promise(r => setTimeout(r, ms));
}

// ============== 多格式解码：各格式 → HTMLCanvasElement ==============

/** 将常见格式（PNG/JPG/WEBP/GIF/BMP）用浏览器原生解码到 canvas */
async function decodeImageFileToCanvas(file) {
    // 优先使用 createImageBitmap（更快、可离屏解码）
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(bitmap, 0, 0);
            // bitmap 不再需要
            if (typeof bitmap.close === 'function') bitmap.close();
            return canvas;
        } catch (err) {
            // fallthrough 到 <img> 方式
            console.warn('[decode] createImageBitmap 失败，退回 <img>：', err);
        }
    }
    // 退回使用 <img> + object URL
    return await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas);
            } catch (err) {
                reject(err);
            } finally {
                URL.revokeObjectURL(url);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('图片解码失败（格式可能不受浏览器支持）'));
        };
        img.src = url;
    });
}

/** 使用 UTIF 解析 TIFF 文件到 canvas（取第一页） */
async function decodeTiffFileToCanvas(file) {
    if (typeof UTIF === 'undefined') {
        throw new Error('TIFF 解析库未加载，请检查网络');
    }
    const buffer = await file.arrayBuffer();
    const ifds = UTIF.decode(buffer);
    if (!ifds || ifds.length === 0) {
        throw new Error('TIFF 文件无有效图像页');
    }
    // 多页 TIFF：只取第一页
    const page = ifds[0];
    UTIF.decodeImage(buffer, page, ifds);
    const rgba = UTIF.toRGBA8(page);  // Uint8Array
    const w = page.width;
    const h = page.height;
    if (!w || !h) throw new Error('TIFF 页面尺寸无效');

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(w, h);
    imgData.data.set(rgba);
    ctx.putImageData(imgData, 0, 0);
    return canvas;
}

/**
 * 解析 ICO 文件，取最大尺寸的 PNG/BMP 帧 → canvas
 * ICO 格式：6 字节头 + n × 16 字节 ICONDIRENTRY + 每帧数据
 */
async function decodeIcoFileToCanvas(file) {
    const buffer = await file.arrayBuffer();
    const dv = new DataView(buffer);
    const reserved = dv.getUint16(0, true);
    const type = dv.getUint16(2, true);
    const count = dv.getUint16(4, true);
    if (reserved !== 0 || (type !== 1 && type !== 2) || count === 0) {
        throw new Error('ICO 文件格式无效');
    }

    // 遍历所有帧，挑选"宽度最大 且 位深最高"的那一帧
    let best = null;
    for (let i = 0; i < count; i++) {
        const off = 6 + i * 16;
        let w = dv.getUint8(off);      // 0 表示 256
        let h = dv.getUint8(off + 1);
        if (w === 0) w = 256;
        if (h === 0) h = 256;
        const planes   = dv.getUint16(off + 4, true);
        const bitCount = dv.getUint16(off + 6, true);
        const size     = dv.getUint32(off + 8, true);
        const offset   = dv.getUint32(off + 12, true);
        const entry = { w, h, bitCount, size, offset };
        if (!best || w > best.w || (w === best.w && bitCount > best.bitCount)) {
            best = entry;
        }
    }
    if (!best) throw new Error('ICO 无可用帧');

    // 取出该帧的原始字节
    const frameBytes = new Uint8Array(buffer, best.offset, best.size);

    // 判断是 PNG 帧（以 89 50 4E 47 开头）还是 BMP/DIB 帧
    const isPng = frameBytes.length >= 8 &&
                  frameBytes[0] === 0x89 && frameBytes[1] === 0x50 &&
                  frameBytes[2] === 0x4E && frameBytes[3] === 0x47;

    if (isPng) {
        // 直接当 PNG 解码
        const blob = new Blob([frameBytes], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        try {
            const canvas = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth || best.w;
                    c.height = img.naturalHeight || best.h;
                    c.getContext('2d').drawImage(img, 0, 0);
                    resolve(c);
                };
                img.onerror = () => reject(new Error('ICO 内嵌 PNG 解码失败'));
                img.src = url;
            });
            return canvas;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // BMP/DIB 帧：帧内的 BMP 头没有 BITMAPFILEHEADER，只有 BITMAPINFOHEADER
    // 且高度是 2 倍（XOR mask + AND mask），我们只解 XOR mask
    const frameDv = new DataView(frameBytes.buffer, frameBytes.byteOffset, frameBytes.byteLength);
    const headerSize = frameDv.getUint32(0, true);          // 通常 40
    const bmpW = frameDv.getInt32(4, true);
    const bmpHx2 = frameDv.getInt32(8, true);
    const bmpH = Math.abs(bmpHx2) / 2;
    const bpp = frameDv.getUint16(14, true);                // 位深

    if (headerSize !== 40 && headerSize !== 108 && headerSize !== 124) {
        throw new Error(`ICO 内部 BMP 头不支持（size=${headerSize}）`);
    }
    if (bpp !== 32 && bpp !== 24 && bpp !== 8 && bpp !== 4 && bpp !== 1) {
        throw new Error(`ICO 内部 BMP 位深不支持：${bpp}`);
    }

    // 我们拼一个完整 BMP 文件让浏览器解码（只处理 24/32bpp，这是 ICO 最常见情况）
    // 实在不行就自己按 32bpp 直接读像素
    if (bpp === 32 || bpp === 24) {
        const rowSize = Math.floor((bpp * bmpW + 31) / 32) * 4;
        const pixelDataSize = rowSize * bmpH;
        const fileSize = 14 + headerSize + pixelDataSize;

        const out = new Uint8Array(fileSize);
        // BITMAPFILEHEADER (14 bytes)
        out[0] = 0x42; out[1] = 0x4D;                                           // "BM"
        new DataView(out.buffer).setUint32(2, fileSize, true);                  // file size
        new DataView(out.buffer).setUint32(10, 14 + headerSize, true);          // data offset
        // BITMAPINFOHEADER（直接复制帧头，但把高度改为正的 bmpH）
        out.set(new Uint8Array(frameBytes.buffer, frameBytes.byteOffset, headerSize), 14);
        new DataView(out.buffer).setInt32(14 + 8, bmpH, true);                  // height = bmpH
        // 像素数据：从帧内偏移 headerSize 起，长度 pixelDataSize
        const pixelsStart = frameBytes.byteOffset + headerSize;
        out.set(new Uint8Array(frameBytes.buffer, pixelsStart, pixelDataSize), 14 + headerSize);

        const blob = new Blob([out], { type: 'image/bmp' });
        const url = URL.createObjectURL(blob);
        try {
            return await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth || bmpW;
                    c.height = img.naturalHeight || bmpH;
                    c.getContext('2d').drawImage(img, 0, 0);
                    resolve(c);
                };
                img.onerror = () => reject(new Error('ICO 内嵌 BMP 解码失败'));
                img.src = url;
            });
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    throw new Error(`ICO 位深 ${bpp} 暂未支持，请用其他工具转换`);
}

/** 将 PSD 文件解析为 HTMLCanvasElement（抽取自原 convertPsdToJpg 的前半段） */
async function decodePsdFileToCanvas(file, onProgress, isLarge) {
    // === 预检 1：文件体积是否超过 ArrayBuffer 安全上限 ===
    if (file.size > ARRAY_BUFFER_SAFE_MAX) {
        throw new Error(
            `文件过大（${formatSize(file.size)}），超过浏览器 ArrayBuffer 安全上限 ${formatSize(ARRAY_BUFFER_SAFE_MAX)}。` +
            `请使用更小的 PSD 或切换到桌面端专业工具处理。`
        );
    }

    onProgress(5);
    let arrayBuffer;
    try {
        arrayBuffer = await file.arrayBuffer();
    } catch (err) {
        throw new Error(
            `文件读取失败（${formatSize(file.size)}）：${err.message || err}。` +
            `可能是内存不足，请关闭其他标签页或改用更小的文件。`
        );
    }
    onProgress(18);

    if (isLarge) await yieldToBrowser(30);

    if (typeof agPsd === 'undefined' || typeof agPsd.readPsd !== 'function') {
        throw new Error('PSD 解析库未加载，请检查网络');
    }

    let psd;
    try {
        psd = agPsd.readPsd(arrayBuffer, {
            skipLayerImageData: true,
            skipThumbnail: true,
            skipCompositeImageData: false
        });
    } catch (err) {
        arrayBuffer = null;
        throw new Error('PSD 解析失败：' + (err.message || err));
    }
    arrayBuffer = null;
    onProgress(55);

    if (isLarge) await yieldToBrowser(20);

    let srcCanvas = psd.canvas;
    if (!srcCanvas) {
        if (psd.imageData) {
            srcCanvas = document.createElement('canvas');
            srcCanvas.width = psd.width;
            srcCanvas.height = psd.height;
            srcCanvas.getContext('2d').putImageData(psd.imageData, 0, 0);
        } else {
            psd = null;
            throw new Error('无法获取 PSD 合成图像');
        }
    }
    // 不再需要 psd 对象本身
    psd = null;
    return srcCanvas;
}

/**
 * 通用：将任意受支持的输入文件转为图片 Blob（JPG 或 PNG）
 * 根据 file 的扩展名自动分发到对应解码器，然后统一进行缩放 / 背景填充 / 输出
 * @param {File} file
 * @param {(p:number)=>void} onProgress 0-100
 */
async function convertFileToImage(file, onProgress) {
    onProgress(2);

    const isLarge = file.size >= LARGE_FILE_THRESHOLD;
    const isHuge  = file.size >= HUGE_FILE_THRESHOLD;
    const kind = detectInputKind(file);

    onProgress(5);

    // --- 第 1 阶段：按类型解码为 srcCanvas ---
    let srcCanvas;
    try {
        if (kind === 'psd') {
            srcCanvas = await decodePsdFileToCanvas(file, onProgress, isLarge);
        } else if (kind === 'tiff') {
            srcCanvas = await decodeTiffFileToCanvas(file);
            onProgress(55);
        } else if (kind === 'ico') {
            srcCanvas = await decodeIcoFileToCanvas(file);
            onProgress(55);
        } else if (kind === 'image') {
            srcCanvas = await decodeImageFileToCanvas(file);
            onProgress(55);
        } else {
            throw new Error(`暂不支持的文件类型：${file.name}`);
        }
    } catch (err) {
        throw new Error(err.message || String(err));
    }

    if (!srcCanvas) throw new Error('解码失败：未得到图像数据');

    const srcW = srcCanvas.width;
    const srcH = srcCanvas.height;
    if (srcW === 0 || srcH === 0) {
        srcCanvas = null;
        throw new Error('图像尺寸异常（0×0）');
    }

    onProgress(72);

    // --- 第 2 阶段：按参数缩放 + 背景填充 + 输出 Blob（所有格式共用）---

    const eff = getEffectiveParams();
    const quality = eff.quality;
    const bg = eff.bgColor;
    const format = getOutputFormat();            // 'jpg' | 'png'
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';

    // === 1) 根据 resizeMode 计算"目标画布尺寸" + 源图在画布中的绘制方式 ===
    let outW = srcW;
    let outH = srcH;
    let drawParams = { dx: 0, dy: 0, dw: srcW, dh: srcH };

    if (eff.resizeMode === 'maxSide') {
        let maxSize = eff.maxSize || 0;
        const autoCap = isHuge ? LARGE_FILE_CANVAS_MAX_DIM
                      : isLarge ? SAFE_CANVAS_MAX_DIM
                      : 0;
        if (autoCap > 0 && (maxSize === 0 || maxSize > autoCap)) {
            maxSize = autoCap;
            console.info(`[大文件优化] ${file.name}（${formatSize(file.size)}）自动降采样至 ${autoCap}px`);
        }
        const HARD_CANVAS_MAX = SAFE_CANVAS_MAX_DIM;
        const effectiveCap = maxSize > 0 ? Math.min(maxSize, HARD_CANVAS_MAX) : HARD_CANVAS_MAX;

        outW = srcW;
        outH = srcH;
        if (Math.max(outW, outH) > effectiveCap) {
            const ratio = effectiveCap / Math.max(outW, outH);
            outW = Math.max(1, Math.round(outW * ratio));
            outH = Math.max(1, Math.round(outH * ratio));
        }
        drawParams = { dx: 0, dy: 0, dw: outW, dh: outH };
    } else if (eff.resizeMode === 'wh') {
        let tw = eff.targetW || 0;
        let th = eff.targetH || 0;
        const fit = eff.fitMode || 'contain';

        if (tw <= 0 && th <= 0) { tw = srcW; th = srcH; }
        else if (tw <= 0) { tw = Math.max(1, Math.round(srcW * (th / srcH))); }
        else if (th <= 0) { th = Math.max(1, Math.round(srcH * (tw / srcW))); }

        const autoCap = isHuge ? LARGE_FILE_CANVAS_MAX_DIM
                      : isLarge ? SAFE_CANVAS_MAX_DIM
                      : SAFE_CANVAS_MAX_DIM;
        if (Math.max(tw, th) > autoCap) {
            const r = autoCap / Math.max(tw, th);
            tw = Math.max(1, Math.round(tw * r));
            th = Math.max(1, Math.round(th * r));
            console.info(`[大文件优化] ${file.name} 目标尺寸超过 ${autoCap}px，等比压缩到 ${tw}×${th}`);
        }

        outW = tw;
        outH = th;

        const srcRatio = srcW / srcH;
        const dstRatio = tw / th;
        if (fit === 'fill') {
            drawParams = { dx: 0, dy: 0, dw: tw, dh: th };
        } else if (fit === 'cover') {
            let dw, dh;
            if (srcRatio > dstRatio) { dh = th; dw = Math.round(th * srcRatio); }
            else { dw = tw; dh = Math.round(tw / srcRatio); }
            drawParams = { dx: Math.round((tw - dw) / 2), dy: Math.round((th - dh) / 2), dw, dh };
        } else {
            let dw, dh;
            if (srcRatio > dstRatio) { dw = tw; dh = Math.round(tw / srcRatio); }
            else { dh = th; dw = Math.round(th * srcRatio); }
            drawParams = { dx: Math.round((tw - dw) / 2), dy: Math.round((th - dh) / 2), dw, dh };
        }
    } else {
        const autoCap = isHuge ? LARGE_FILE_CANVAS_MAX_DIM
                      : isLarge ? SAFE_CANVAS_MAX_DIM
                      : 0;
        if (autoCap > 0 && Math.max(srcW, srcH) > autoCap) {
            const ratio = autoCap / Math.max(srcW, srcH);
            outW = Math.max(1, Math.round(srcW * ratio));
            outH = Math.max(1, Math.round(srcH * ratio));
            console.info(`[大文件优化] ${file.name}（${formatSize(file.size)}）自动降采样至 ${autoCap}px`);
        } else {
            outW = srcW;
            outH = srcH;
        }
        drawParams = { dx: 0, dy: 0, dw: outW, dh: outH };
    }

    let outCanvas = document.createElement('canvas');
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext('2d');

    // 背景：JPG 强制填充；PNG 始终保持透明（保留原图透明通道，不填充背景色）
    if (format === 'jpg') {
        outCtx.fillStyle = bg;
        outCtx.fillRect(0, 0, outW, outH);
    } else {
        outCtx.clearRect(0, 0, outW, outH);
    }
    try {
        outCtx.drawImage(srcCanvas, drawParams.dx, drawParams.dy, drawParams.dw, drawParams.dh);
    } catch (err) {
        srcCanvas = null;
        outCanvas = null;
        throw new Error('绘制失败（可能内存不足）：' + (err.message || err));
    }

    onProgress(85);

    // 大文件时释放原始 canvas
    if (isLarge && srcCanvas !== outCanvas) {
        try { srcCanvas.width = 0; srcCanvas.height = 0; } catch (_) { /* ignore */ }
    }
    srcCanvas = null;

    if (isLarge) await yieldToBrowser(10);

    // 缩略图
    const thumbCanvas = document.createElement('canvas');
    const thumbMax = 120;
    const tRatio = Math.min(1, thumbMax / Math.max(outW, outH));
    thumbCanvas.width = Math.max(1, Math.round(outW * tRatio));
    thumbCanvas.height = Math.max(1, Math.round(outH * tRatio));
    const thumbCtx = thumbCanvas.getContext('2d');
    if (format === 'jpg') {
        thumbCtx.fillStyle = bg;
        thumbCtx.fillRect(0, 0, thumbCanvas.width, thumbCanvas.height);
    }
    thumbCtx.drawImage(outCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    const thumbUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);

    // 输出 Blob
    const blob = await new Promise((resolve, reject) => {
        const onBlob = (b) => {
            if (b) resolve(b);
            else reject(new Error('Canvas 导出 Blob 失败（可能画布超出浏览器限制或内存不足）'));
        };
        try {
            if (format === 'png') outCanvas.toBlob(onBlob, mimeType);
            else                  outCanvas.toBlob(onBlob, mimeType, quality);
        } catch (err) { reject(err); }
    });

    try { outCanvas.width = 0; outCanvas.height = 0; } catch (_) { /* ignore */ }
    outCanvas = null;

    onProgress(100);

    return {
        blob,
        thumbUrl,
        width: srcW,
        height: srcH,
        outWidth: outW,
        outHeight: outH
    };
}

// ============== 保存逻辑 ==============

/** 保存单个文件到指定目录 */
async function saveToDirectory(dirHandle, fileName, blob) {
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
}

/** 触发单文件下载 */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============== 事件绑定 ==============

/** 安全绑定事件，元素不存在时打印警告而非抛异常 */
function on(el, type, handler, name) {
    if (!el) {
        console.warn(`[psd2jpg] 元素不存在，跳过事件绑定：${name || type}`);
        return;
    }
    el.addEventListener(type, handler);
}

// 文件选择
on(fileInput, 'change', (e) => {
    if (e.target.files && e.target.files.length) {
        addFiles(e.target.files);
        fileInput.value = '';
    }
}, 'fileInput.change');

// 拖拽
['dragenter', 'dragover'].forEach(ev => {
    on(dropZone, ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('dragover');
    }, `dropZone.${ev}`);
});
['dragleave', 'drop'].forEach(ev => {
    on(dropZone, ev, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover');
    }, `dropZone.${ev}`);
});
on(dropZone, 'drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) addFiles(files);
}, 'dropZone.drop');

// 任务列表点击委托
on(taskListEl, 'click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;

    if (action === 'remove') {
        state.tasks = state.tasks.filter(t => t.id !== id);
        renderAll();
    } else if (action === 'download' && task.jpgBlob) {
        downloadBlob(task.jpgBlob, task.outName);
    }
}, 'taskList.click');

// 清空
on(clearBtn, 'click', () => {
    if (state.converting) {
        toast('转换进行中，无法清空', 'warn');
        return;
    }
    state.tasks = [];
    renderAll();
}, 'clearBtn.click');

// 质量滑杆
on(qualityRange, 'input', () => {
    qualityValue.textContent = parseFloat(qualityRange.value).toFixed(2);
}, 'qualityRange.input');

// ============== 输出尺寸模式切换 ==============
function refreshResizePanel() {
    const mode = getResizeMode();
    document.querySelectorAll('.resize-panel').forEach(el => el.classList.add('hidden'));
    const active = document.getElementById('resizePanel-' + mode);
    if (active) active.classList.remove('hidden');
}
resizeModeRadios.forEach(r => on(r, 'change', refreshResizePanel, 'resizeMode.change'));
refreshResizePanel();

if (maxSidePresetsEl) {
    on(maxSidePresetsEl, 'click', (e) => {
        const btn = e.target.closest('button[data-v]');
        if (!btn) return;
        if (maxSizeInput) maxSizeInput.value = btn.dataset.v;
    }, 'maxSidePresets.click');
}

function clampIntInput(inputEl, min, max) {
    if (!inputEl) return;
    on(inputEl, 'blur', () => {
        const v = parseInt(inputEl.value, 10);
        if (isNaN(v) || v <= 0) { inputEl.value = ''; return; }
        if (v < min) inputEl.value = String(min);
        else if (v > max) inputEl.value = String(max);
    }, inputEl.id + '.blur');
}
clampIntInput(maxSizeInput, 16, 16384);
clampIntInput(targetWInput, 1, 16384);
clampIntInput(targetHInput, 1, 16384);

// 背景色
on(bgColorInput, 'input', () => {
    bgColorText.value = bgColorInput.value;
}, 'bgColor.input');
on(bgColorText, 'input', () => {
    const v = bgColorText.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        bgColorInput.value = v;
    }
}, 'bgColorText.input');

// 前缀改变时实时更新输出名
on(prefixInput, 'input', () => {
    state.tasks.forEach(t => { t.outName = buildOutputName(t.name); });
}, 'prefix.input');

// ============== 参数开关逻辑 ==============

/** 刷新参数开关 UI 状态（遮罩/文案） */
function refreshParamToggleUI() {
    if (!paramToggle) return;
    const on = paramToggle.checked;
    if (paramToggleText) {
        paramToggleText.textContent = on ? '已开启' : '已关闭';
        paramToggleText.className = on
            ? 'text-xs text-brand-600 font-medium'
            : 'text-xs text-slate-500';
    }
    if (paramMask) {
        paramMask.style.display = on ? 'none' : 'flex';
    }
    // 参数面板区域的视觉可用性
    const paramBody = document.getElementById('paramBody');
    if (paramBody) {
        paramBody.classList.toggle('opacity-50', !on);
    }
    // 开关切换时，需要刷新任务列表输出名（前缀生效/失效）
    state.tasks.forEach(t => { t.outName = buildOutputName(t.name); });
}

on(paramToggle, 'change', () => {
    refreshParamToggleUI();
}, 'paramToggle.change');

// 初始化参数开关 UI（默认关闭）
refreshParamToggleUI();

// ============== 输出格式切换 ==============

/** 刷新输出格式相关的提示文案 */
function refreshFormatUI() {
    const fmt = getOutputFormat();
    if (formatHintEl) {
        formatHintEl.textContent = fmt === 'png'
            ? '无损 · 支持透明'
            : '有损压缩 · 体积更小';
    }
    if (formatDescEl) {
        formatDescEl.textContent = fmt === 'png'
            ? 'PNG：无损压缩、保留透明通道；体积较大，适合图标、UI 切图等素材'
            : 'JPG：体积小、适合照片类素材；不支持透明（透明区将按背景色填充）';
    }
    // PNG 时：禁用"透明区域填充"（输出始终保持透明）
    const bgGroup   = document.getElementById('bgColorGroup');
    const bgBadge   = document.getElementById('bgColorDisabledBadge');
    const bgHint    = document.getElementById('bgColorHint');
    const isPng     = fmt === 'png';
    if (bgGroup) {
        bgGroup.classList.toggle('opacity-50', isPng);
        bgGroup.classList.toggle('pointer-events-none', isPng);
    }
    if (bgColorInput) bgColorInput.disabled = isPng;
    if (bgColorText)  bgColorText.disabled  = isPng;
    if (bgBadge) bgBadge.classList.toggle('hidden', !isPng);
    if (bgHint)  bgHint.classList.toggle('hidden',  !isPng);
    // 更新所有任务的输出文件名（扩展名）
    state.tasks.forEach(t => { t.outName = buildOutputName(t.name); });
}

formatRadios.forEach(r => {
    on(r, 'change', refreshFormatUI, 'outputFormat.change');
});
refreshFormatUI();

// ============== ZIP 分卷逻辑 ==============

/** 获取用户选择的单包大小上限（字节） */
function getZipSplitBytes() {
    if (!zipSplitSizeSel) return 0;
    const v = parseInt(zipSplitSizeSel.value, 10);
    return isNaN(v) ? 0 : v;
}

/**
 * 根据每个任务的 JPG Blob 体积，按"首次装箱"算法分卷
 * @param {Array<{outName:string, jpgBlob:Blob, outSize:number}>} items 已转换成功的任务
 * @param {number} limitBytes 单包大小上限（字节），0 表示不分卷
 * @returns {Array<Array<typeof items[number]>>} 每一卷的任务数组
 */
function splitIntoParts(items, limitBytes) {
    if (!limitBytes || limitBytes <= 0 || items.length === 0) {
        return [items.slice()];
    }
    const parts = [];
    let current = [];
    let currentSize = 0;
    for (const it of items) {
        const size = (it.jpgBlob && it.jpgBlob.size) || it.outSize || 0;
        // 单文件超过单包上限时，只能单独成一卷
        if (size > limitBytes) {
            if (current.length) {
                parts.push(current);
                current = [];
                currentSize = 0;
            }
            parts.push([it]);
            continue;
        }
        if (currentSize + size > limitBytes && current.length > 0) {
            parts.push(current);
            current = [];
            currentSize = 0;
        }
        current.push(it);
        currentSize += size;
    }
    if (current.length) parts.push(current);
    return parts;
}

/** 预估分卷数：基于原 PSD 大小 × 经验系数，用于开始转换前给提醒 */
function estimateZipParts() {
    const limitBytes = getZipSplitBytes();
    if (!limitBytes) return 1;
    // PSD 转 JPG 后体积通常为原 PSD 的 10% ~ 50%，这里取保守估值 35%
    const estOutputBytes = state.tasks.reduce((s, t) => s + t.file.size, 0) * 0.35;
    return Math.max(1, Math.ceil(estOutputBytes / limitBytes));
}

// 分卷下拉变化时不需要特殊处理，开始转换时会读取最新值

// 保存方式切换
$$('input[name="saveMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
        $$('input[name="saveMode"]').forEach(r => {
            const label = r.closest('label');
            // 左侧强调条
            const accent = label.querySelector('span.absolute');
            if (r.checked) {
                label.classList.remove('border-slate-200');
                label.classList.add('border-brand-500', 'bg-brand-50/50');
                if (accent) {
                    accent.classList.remove('bg-transparent');
                    accent.classList.add('bg-brand-500');
                }
            } else {
                label.classList.add('border-slate-200');
                label.classList.remove('border-brand-500', 'bg-brand-50/50');
                if (accent) {
                    accent.classList.add('bg-transparent');
                    accent.classList.remove('bg-brand-500');
                }
            }
        });
        // ZIP 分卷设置仅在 ZIP 模式下显示
        if (zipSplitWrap) {
            zipSplitWrap.style.display = getSaveMode() === 'zip' ? 'inline-flex' : 'none';
        }
        updateBatchStats();
    });
});

// 初始化时根据当前选中模式决定分卷设置显隐
if (zipSplitWrap) {
    zipSplitWrap.style.display = getSaveMode() === 'zip' ? 'inline-flex' : 'none';
}

// 选择保存目录
pickDirBtn.addEventListener('click', async (e) => {
    // 按钮位于 <label> 内，阻止默认行为避免冒泡切换 radio，选完后再显式切换
    e.preventDefault();
    e.stopPropagation();
    if (!window.showDirectoryPicker) {
        toast('当前浏览器不支持选择目录，请使用 Chrome 或 Edge', 'error');
        return;
    }
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        state.directoryHandle = handle;
        dirNameEl.textContent = handle.name;
        dirInfo.classList.remove('hidden');
        toast(`已选择目录：${handle.name}`, 'success');
        // 自动切到"目录"模式
        document.querySelector('input[name="saveMode"][value="directory"]').checked = true;
        document.querySelector('input[name="saveMode"][value="directory"]').dispatchEvent(new Event('change'));
    } catch (err) {
        if (err.name !== 'AbortError') {
            toast('选择目录失败：' + err.message, 'error');
        }
    }
});

// 开始转换
convertBtn.addEventListener('click', async () => {
    if (state.converting) return;
    if (state.tasks.length === 0) {
        toast('请先添加图片文件', 'warn');
        return;
    }

    // 【关键修复】用户点击"开始转换"时，无论任务之前是什么状态（success/saved/error），
    // 都强制重置为 pending 并清空上一轮产物，确保调整参数后可以重新按新参数跑。
    // 这段逻辑必须放在所有 early return 之前，避免用户多次点击重置不生效。
    state.tasks.forEach(t => {
        if (t.status !== 'processing') {
            if (t.jpgBlob) {
                try { URL.revokeObjectURL(t.jpgBlobUrl); } catch (_) {}
                t.jpgBlob = null;
                t.jpgBlobUrl = null;
            }
            t.status = 'pending';
            t.progress = 0;
            t.error = '';
            t.outSize = 0;
            t.outName = buildOutputName(t.name);
            renderTask(t);
        }
    });

    // 批次健康度校验
    const assess = evaluateBatch();
    if (assess.level === 'danger') {
        const ok = window.confirm(
            `⚠️ 当前批次已超过安全阈值：\n\n${assess.tip}\n\n` +
            `继续执行可能导致浏览器内存溢出或崩溃。\n` +
            `建议：点击"取消"后分批处理（每批 ≤ ${assess.limit} 个文件），或切换到"保存到指定文件夹"模式以降低内存占用。\n\n` +
            `确定要强制继续转换吗？`
        );
        if (!ok) {
            toast('已取消，请分批处理', 'info');
            return;
        }
    } else if (assess.level === 'warn') {
        toast(`批次偏大，建议留意浏览器内存占用`, 'warn');
    }

    const saveMode = getSaveMode();

    // ZIP 模式：如启用分卷，预估分包数并提醒用户
    if (saveMode === 'zip') {
        const splitBytes = getZipSplitBytes();
        if (splitBytes > 0) {
            const estParts = estimateZipParts();
            if (estParts > 1) {
                const ok = window.confirm(
                    `📦 ZIP 分卷提醒\n\n` +
                    `当前批次预计体积较大，按"每包 ≤ ${formatSize(splitBytes)}"的规则，\n` +
                    `将自动分成 约 ${estParts} 个压缩包 依次下载\n\n` +
                    `（实际分卷数以转换后的 JPG 实际大小为准，可能有 ±1 的偏差）\n\n` +
                    `继续开始转换？`
                );
                if (!ok) {
                    toast('已取消，可调整"单个 ZIP 包大小上限"后重试', 'info');
                    return;
                }
            }
        }
    }

    if (saveMode === 'directory') {
        if (!window.showDirectoryPicker) {
            toast('当前浏览器不支持保存到指定文件夹，请改用 ZIP 模式', 'error');
            return;
        }
        if (!state.directoryHandle) {
            // 让用户现在选择一个
            try {
                const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
                state.directoryHandle = handle;
                dirNameEl.textContent = handle.name;
                dirInfo.classList.remove('hidden');
            } catch (err) {
                if (err.name !== 'AbortError') toast('未选择目录', 'warn');
                return;
            }
        }
        // 验证写入权限
        try {
            const perm = await state.directoryHandle.queryPermission({ mode: 'readwrite' });
            if (perm !== 'granted') {
                const req = await state.directoryHandle.requestPermission({ mode: 'readwrite' });
                if (req !== 'granted') {
                    toast('未授予目录写入权限', 'error');
                    return;
                }
            }
        } catch (err) { /* 某些实现可能没有该方法 */ }
    }

    state.converting = true;
    convertBtn.disabled = true;
    convertBtn.innerHTML = '<i class="fa-solid fa-spinner spin mr-2"></i>转换中...';
    overallProgressWrap.classList.remove('hidden');

    // 处理队列：所有非 processing 的任务都重新跑（上面已经把成功/失败都重置为 pending）
    const queue = state.tasks.filter(t => t.status === 'pending' || t.status === 'processing');

    // 兜底：如果没有可转换的任务，直接恢复按钮并提示
    if (queue.length === 0) {
        state.converting = false;
        convertBtn.disabled = state.tasks.length === 0;
        convertBtn.innerHTML = '<i class="fa-solid fa-play mr-2"></i>开始转换';
        overallProgressWrap.classList.add('hidden');
        toast('没有可转换的任务，请重新上传文件', 'warn');
        return;
    }

    let done = 0;
    overallProgressText.textContent = `0 / ${queue.length}`;
    overallProgressBar.style.width = '0%';

    // ZIP 模式改为先收集，最后按分卷规则打包
    const zipItems = saveMode === 'zip' ? [] : null;
    let successCount = 0;
    let errorCount = 0;

    for (const task of queue) {
        task.status = 'processing';
        task.progress = 0;
        task.error = '';
        renderTask(task);

        const isLargeTask = task.file.size >= LARGE_FILE_THRESHOLD;

        try {
            const { blob, thumbUrl, width, height } = await convertFileToImage(task.file, (p) => {
                task.progress = p;
                renderTask(task);
            });

            task.jpgBlob = blob;
            task.thumbUrl = thumbUrl;
            task.width = width;
            task.height = height;
            task.outSize = blob.size;
            task.outName = buildOutputName(task.name);

            // 根据保存方式处理
            if (saveMode === 'directory' && state.directoryHandle) {
                await saveToDirectory(state.directoryHandle, task.outName, blob);
                task.status = 'saved';
                // 大文件模式下，目录模式已经写入磁盘，立即释放内存中的 Blob 引用
                if (isLargeTask) {
                    task.jpgBlob = null;
                }
            } else if (saveMode === 'zip') {
                zipItems.push({ outName: task.outName, jpgBlob: blob, outSize: blob.size });
                task.status = 'success';
            } else if (saveMode === 'each') {
                downloadBlob(blob, task.outName);
                task.status = 'success';
                // 逐个下载模式：浏览器已持有 Blob 引用，这里可以释放任务侧引用
                if (isLargeTask) {
                    task.jpgBlob = null;
                }
            } else {
                task.status = 'success';
            }

            task.progress = 100;
            successCount++;
        } catch (err) {
            console.error(err);
            task.status = 'error';
            task.error = err.message || String(err);
            errorCount++;
        }

        renderTask(task);
        done++;
        const percent = Math.round((done / queue.length) * 100);
        overallProgressBar.style.width = percent + '%';
        overallProgressText.textContent = `${done} / ${queue.length}`;

        // 大文件任务结束后主动让出主线程，给浏览器 GC 一个喘息机会
        if (isLargeTask) {
            await yieldToBrowser(200);
        } else {
            // 即使普通任务也让出一次，避免 UI 卡顿
            await yieldToBrowser(0);
        }
    }

    // ZIP 模式：按分卷规则打包并下载（可能多卷）
    if (saveMode === 'zip' && zipItems && zipItems.length > 0) {
        const splitBytes = getZipSplitBytes();
        const parts = splitIntoParts(zipItems, splitBytes);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const totalParts = parts.length;
        const fmtTag = getOutputFormat(); // jpg / png
        const zipPrefix = `images2${fmtTag}`;

        for (let i = 0; i < parts.length; i++) {
            const partItems = parts[i];
            const partZip = new JSZip();
            partItems.forEach(it => partZip.file(it.outName, it.jpgBlob));

            try {
                const partIndex = totalParts > 1 ? `_part${String(i + 1).padStart(2, '0')}of${String(totalParts).padStart(2, '0')}` : '';
                overallProgressText.textContent = totalParts > 1
                    ? `打包第 ${i + 1}/${totalParts} 包 0%`
                    : `打包中 0%`;

                const content = await partZip.generateAsync(
                    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
                    (meta) => {
                        overallProgressText.textContent = totalParts > 1
                            ? `打包第 ${i + 1}/${totalParts} 包 ${meta.percent.toFixed(0)}%`
                            : `打包中 ${meta.percent.toFixed(0)}%`;
                    }
                );
                const zipName = `${zipPrefix}_${stamp}${partIndex}.zip`;
                if (typeof saveAs === 'function') {
                    saveAs(content, zipName);
                } else {
                    downloadBlob(content, zipName);
                }
                // 浏览器连续下载之间稍留间隔，避免被合并拦截
                if (i < parts.length - 1) {
                    await new Promise(r => setTimeout(r, 600));
                }
            } catch (err) {
                toast(`第 ${i + 1} 包打包失败：` + err.message, 'error');
            }
        }

        overallProgressText.textContent = totalParts > 1
            ? `已下载 ${totalParts} 个分卷包（共 ${successCount} 个文件）`
            : `已打包 ${successCount} 个文件`;

        if (totalParts > 1) {
            toast(`已分 ${totalParts} 个压缩包下载完成`, 'success');
        }
    }

    state.converting = false;
    convertBtn.disabled = state.tasks.length === 0;
    convertBtn.innerHTML = '<i class="fa-solid fa-play mr-2"></i>开始转换';

    if (errorCount === 0) {
        toast(`全部转换完成！共 ${successCount} 个文件`, 'success');
    } else if (successCount === 0) {
        toast(`转换失败：${errorCount} 个文件出错`, 'error');
    } else {
        toast(`完成 ${successCount} 个，失败 ${errorCount} 个`, 'warn');
    }
});

// ============== 初始化 ==============
updateFileCount();
qualityValue.textContent = parseFloat(qualityRange.value).toFixed(2);

// 通知启动遮罩：应用已初始化完成
window.__APP_READY__ = true;

// 检测浏览器能力
if (!window.showDirectoryPicker) {
    const dirRadio = document.querySelector('input[name="saveMode"][value="directory"]');
    const zipRadio = document.querySelector('input[name="saveMode"][value="zip"]');
    if (dirRadio) {
        dirRadio.disabled = true;
        const label = dirRadio.closest('label');
        label.classList.add('opacity-50', 'cursor-not-allowed');
        label.querySelector('p.text-xs').innerHTML += '<br><span class="text-rose-500">（当前浏览器不支持，请改用 Chrome/Edge）</span>';
    }
    if (zipRadio) {
        zipRadio.checked = true;
        zipRadio.dispatchEvent(new Event('change'));
    }
    pickDirBtn.disabled = true;
    pickDirBtn.classList.add('opacity-50', 'cursor-not-allowed');
}

// ============== 手机端适配 ==============

/** 判断当前是否为移动端（User Agent + 视口尺寸双重判定） */
function isMobileDevice() {
    const ua = (navigator.userAgent || navigator.vendor || '').toLowerCase();
    const uaMobile = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);
    const touchMobile = ('ontouchstart' in window) && window.innerWidth <= 768;
    return uaMobile || touchMobile;
}

const IS_MOBILE = isMobileDevice();

// --- 1. 拍照 / 相册 入口：共用 addFiles ---
const cameraInput = document.getElementById('cameraInput');
const albumInput  = document.getElementById('albumInput');

on(cameraInput, 'change', (e) => {
    if (e.target.files && e.target.files.length) {
        addFiles(e.target.files);
        cameraInput.value = '';
    }
}, 'cameraInput.change');

on(albumInput, 'change', (e) => {
    if (e.target.files && e.target.files.length) {
        addFiles(e.target.files);
        albumInput.value = '';
    }
}, 'albumInput.change');

// --- 2. 手机端参数面板折叠 / 展开 ---
const paramsHeader   = document.getElementById('paramsHeader');
const paramsCollapse = document.getElementById('paramsCollapse');
const paramsChevron  = document.getElementById('paramsChevron');

function setParamsCollapsed(collapsed) {
    if (!paramsCollapse) return;
    if (collapsed) {
        paramsCollapse.classList.add('hidden');
        if (paramsChevron) paramsChevron.style.transform = 'rotate(0deg)';
    } else {
        paramsCollapse.classList.remove('hidden');
        if (paramsChevron) paramsChevron.style.transform = 'rotate(180deg)';
    }
}

// 桌面端默认展开，仅真正的移动端（UA 判定）默认折叠；避免 PC 端窄窗口被误判
if (paramsCollapse) {
    if (IS_MOBILE) {
        setParamsCollapsed(true);
    } else {
        setParamsCollapsed(false);
    }
}

// 点击标题行切换折叠状态（仅在移动端生效；PC 端无论窗口多窄都保持展开）
on(paramsHeader, 'click', (e) => {
    // 开关的 label/input 点击不触发折叠
    if (e.target.closest('label') || e.target.closest('input')) return;
    // 仅在移动端生效
    if (!IS_MOBILE) return;
    const isHidden = paramsCollapse.classList.contains('hidden');
    setParamsCollapsed(!isHidden);
}, 'paramsHeader.click');

// 视口尺寸变化时重新评估（例如横竖屏切换）
window.addEventListener('resize', () => {
    if (!paramsCollapse) return;
    // PC 端始终保持展开，不受窗口宽度影响
    if (!IS_MOBILE) {
        setParamsCollapsed(false);
    }
    // 移动端保持用户当前选择，不做自动折叠
});

// --- 3. 手机端自动切换保存模式：目录模式不可用 → 默认 ZIP ---
if (IS_MOBILE || !window.showDirectoryPicker) {
    const dirRadio = document.querySelector('input[name="saveMode"][value="directory"]');
    const zipRadio = document.querySelector('input[name="saveMode"][value="zip"]');
    const saveDirCard = document.getElementById('saveDirCard');

    if (dirRadio) {
        dirRadio.disabled = true;
        dirRadio.checked = false;
    }
    if (saveDirCard) {
        saveDirCard.classList.add('opacity-50', 'pointer-events-none');
        // 追加手机端专用的提示标记（避免重复追加）
        if (!saveDirCard.querySelector('[data-mobile-hint]') && IS_MOBILE) {
            const desc = saveDirCard.querySelector('p.text-xs');
            if (desc) {
                const hint = document.createElement('span');
                hint.setAttribute('data-mobile-hint', 'true');
                hint.className = 'block text-rose-500 mt-0.5';
                hint.textContent = '（手机浏览器暂不支持此模式）';
                desc.appendChild(hint);
            }
        }
    }
    if (pickDirBtn) {
        pickDirBtn.disabled = true;
        pickDirBtn.classList.add('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
    }
    if (zipRadio) {
        zipRadio.checked = true;
        zipRadio.dispatchEvent(new Event('change'));
    }
}

// --- 4. 手机端顶部副标题微调（让空间更紧凑） ---
if (IS_MOBILE) {
    // 手机端顶部副标题太窄容易折行，收紧展示
    const headerSub = document.querySelector('header p.text-xs');
    if (headerSub) {
        headerSub.textContent = '纯浏览器运行 · 零上传';
    }
    // 页面内边距收紧
    const mainEl = document.querySelector('main');
    if (mainEl) {
        mainEl.classList.remove('px-6', 'py-10');
        mainEl.classList.add('px-3', 'py-5');
    }
}

// --- 5. 手机端相册输入的容量保护 ---
// iOS Safari 的相册入口在选择大量照片时会 OOM，我们在 addFiles 时已做硬上限保护
// 这里额外在手机端对"相册"入口限制一次最多 50 张（用户通常也不会超过）
on(albumInput, 'change', (e) => {
    if (IS_MOBILE && e.target.files && e.target.files.length > 50) {
        toast(`相册单次最多选 50 张，已自动截取前 50 张`, 'warn');
    }
}, 'albumInput.sizecheck');

// ============== 企业微信 / 微信 / 移动 WebView 兼容处理 ==============

/** 检测运行环境 */
function detectEnv() {
    const ua = (navigator.userAgent || '').toLowerCase();
    const isWxWork = /wxwork|micromessenger.*wxwork/.test(ua) || /wxwork/.test(ua);
    const isWechat = /micromessenger/.test(ua) && !isWxWork;
    const isQQ     = /\bqq\//.test(ua) || /qqbrowser/.test(ua);
    const isDingTalk = /dingtalk/.test(ua);
    const isFeishu = /feishu|lark/.test(ua);
    const isInAppWebView = isWxWork || isWechat || isQQ || isDingTalk || isFeishu;
    return { ua, isWxWork, isWechat, isQQ, isDingTalk, isFeishu, isInAppWebView };
}

const ENV = detectEnv();

/**
 * 手机 WebView 对 <input accept> 的兼容处理：
 * 企业微信 / 微信 / QQ 等内置浏览器对自定义扩展名（如 .psd）的 accept 支持极差，
 * 会导致点击后弹出的选择器过滤掉 PSD 文件。
 * 解决：在手机端把主 fileInput 和"文件"入口的 accept 全部放开为星号斜杠星号（任意类型），
 * 由 JS 端通过扩展名再做一次过滤（addFiles 内已实现）。
 */
if (IS_MOBILE) {
    if (fileInput) {
        fileInput.setAttribute('accept', '*/*');
    }
}

// 企业微信 / 微信 / 其他 App 内 WebView：显示友好提示
if (ENV.isInAppWebView && IS_MOBILE) {
    const tipEl = document.getElementById('wxworkTip');
    if (tipEl) {
        tipEl.classList.remove('hidden');
        // 根据具体客户端，微调标题
        let title = '检测到您正在 App 内置浏览器中浏览';
        if (ENV.isWxWork) title = '检测到您正在企业微信内浏览';
        else if (ENV.isWechat) title = '检测到您正在微信内浏览';
        else if (ENV.isQQ) title = '检测到您正在 QQ 内浏览';
        else if (ENV.isDingTalk) title = '检测到您正在钉钉内浏览';
        else if (ENV.isFeishu) title = '检测到您正在飞书内浏览';
        const titleEl = tipEl.querySelector('p.font-semibold');
        if (titleEl) titleEl.textContent = title;
    }

    // 启动 3 秒后如果 fileInput 还没收到过 change，再给一次温馨 toast
    let hasPicked = false;
    if (fileInput) {
        fileInput.addEventListener('change', () => { hasPicked = true; }, { once: true });
    }
    setTimeout(() => {
        if (!hasPicked && state.tasks.length === 0) {
            toast('如选择文件无反应，请点右上角「在浏览器中打开」', 'info');
        }
    }, 8000);
}

// 桌面端通过 UA 检测到企业微信（偶尔出现在企业微信 Windows 客户端的内置 WebView 中）也给个轻提示
if (ENV.isWxWork && !IS_MOBILE) {
    const tipEl = document.getElementById('wxworkTip');
    if (tipEl) {
        tipEl.classList.remove('hidden');
        const titleEl = tipEl.querySelector('p.font-semibold');
        if (titleEl) titleEl.textContent = '检测到您正在企业微信客户端内浏览';
        const listEl = tipEl.querySelector('ol');
        if (listEl) {
            listEl.innerHTML = `
                <li>建议使用 <b>Chrome / Edge</b> 浏览器直接访问本网址，以获得完整功能</li>
                <li>企业微信客户端内的 WebView 对"保存到指定文件夹"不支持，已自动切换为 ZIP 下载</li>
            `;
        }
    }
}