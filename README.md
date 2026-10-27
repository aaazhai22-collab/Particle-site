# 鼎模型

本仓库管理青铜方鼎的 Blender 源模型、参考图，以及粒子展示网站。

## 打开网站

网站地址：<https://aaazhai22-collab.github.io/Particle-site/>。

发布方式为 GitHub Pages。网站源码更新并推送到 `main` 后，GitHub 会自动检查、构建和发布；可在仓库的 **Actions** 页面查看进度。发布操作说明见 [GitHub Pages 说明](particle-site/docs/GITHUB-PAGES.md)。

- `青铜方鼎_v002.blend`：Blender 源模型，通过 Git LFS 管理。
- `正视图.png`、`侧视图.png`、`顶视图.png`、`底视图.png`：模型参考图。
- `particle-site/`：网站源码、测试、说明文档和运行所需的示例素材，详见 [网站说明](particle-site/README.md)。

## 获取完整模型

在其他电脑使用仓库前安装 Git LFS，并在仓库目录执行：

```powershell
git lfs install
git lfs pull
```

## 启动网站

安装 Node.js 和 pnpm 后，在仓库目录执行：

```powershell
cd particle-site
pnpm install
pnpm dev
```

## 版本管理范围

保留模型源文件、参考图、网站源码、依赖锁定文件和必要素材。依赖目录、构建产物、部署压缩包、本地验证输出、环境变量文件和 Blender 自动备份由 `.gitignore` 排除；这些文件仍保留在本地。

网站原有提交历史保留在当前仓库中；根目录初始化之前的提交使用网站原来的相对路径。
