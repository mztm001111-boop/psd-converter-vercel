# PSD 批量转换工具 · Vercel 部署包

这是一个纯前端的浏览器端图片批量转换工具，支持 **PSD / PNG / JPG / WEBP / GIF / BMP / TIFF / ICO** 转 JPG / PNG，所有处理均在本地浏览器内完成，**零上传、零服务器**。

## 📁 目录结构

```
psd-converter-vercel/
├── index.html      # 入口 HTML
├── main.js         # 主业务逻辑（ESM）
├── style.css       # 样式补充
├── vercel.json     # Vercel 部署配置（缓存策略 + 安全头）
└── README.md       # 本文件
```

所有第三方依赖（ag-psd、UTIF、JSZip、FileSaver、Tailwind CSS、Font Awesome）均通过 CDN 加载，无需 `node_modules`，无需构建步骤。

---

## 🚀 部署到 Vercel（3 种方式任选其一）

### ✅ 方式 A：拖拽上传（最快 · 30 秒）

1. 打开 <https://vercel.com/new>
2. 登录（推荐用 GitHub 账号登录）
3. 滚动到底部，将**整个 `psd-converter-vercel` 文件夹**拖到页面上
4. 等待部署完成，获得形如 `https://psd-converter-xxx.vercel.app` 的永久链接

### ✅ 方式 B：Vercel CLI（适合命令行党）

```bash
# 安装 CLI（只需一次）
npm i -g vercel

# 进入本文件夹
cd psd-converter-vercel

# 首次部署（跟着提示走即可）
vercel

# 正式发布到生产环境
vercel --prod
```

### ✅ 方式 C：GitHub + Vercel 自动部署（适合长期维护）

1. 把本文件夹推到一个 GitHub 仓库
2. 在 <https://vercel.com/new> 选择这个仓库 → 点 **Deploy**
3. 以后每次 `git push`，Vercel 会自动重新部署，**域名不变**

---

## 🌐 部署后效果

- **永久域名**：`https://<你的项目名>.vercel.app`（外部人员可直接访问，无需登录 IOA）
- **手机端可用**：在 iPhone / Android 浏览器中打开即可使用
- **企业微信内打开**：会自动检测环境并提示在系统浏览器中打开（以兼容文件选择）
- **HTTPS**：Vercel 自动配置，免费证书

---

## 🔧 自定义域名（可选）

1. 在 Vercel 项目 → **Settings** → **Domains** 添加你的域名
2. 按提示在域名服务商处配置 DNS（CNAME 或 A 记录）
3. 证书自动签发

> ⚠️ 如果域名在国内注册商，且想让国内用户访问更流畅，建议走 ICP 备案 + 国内 CDN（腾讯云 COS / 阿里云 OSS）。Vercel 本身对国内访问偶尔不稳定。

---

## 🛠 常见问题

| 问题 | 解决方案 |
|---|---|
| 打开后发现不是最新版？ | 硬刷新（`Ctrl+Shift+R` / `Cmd+Shift+R`），本项目已禁用 HTML/JS/CSS 缓存 |
| 手机企业微信打不开？ | 右上角 ··· → "在浏览器中打开" |
| 选择文件夹功能不可用？ | 该功能依赖 `File System Access API`，仅 Chrome/Edge 桌面版支持；其他浏览器请用 ZIP 下载 |
| 大文件卡死？ | 单文件建议 ≤ 800MB；超过 300MB 会自动降采样 |

---

## 📝 更新部署

- **方式 A 拖拽**：再次进入 Vercel Dashboard → 项目 → **Deployments** → 右上角 **Redeploy** 或重新拖拽覆盖
- **方式 B CLI**：在本文件夹中再次运行 `vercel --prod`
- **方式 C GitHub**：`git push` 即可

域名始终不变，始终指向最新版。
