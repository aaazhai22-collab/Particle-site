# GitHub Pages 发布

网站地址：<https://aaazhai22-collab.github.io/Particle-site/>。

打开这个网址即可使用网站。GitHub 仓库页面用于查看代码，网站链接可以直接分享给别人。

## 更新网站

1. 修改 `particle-site/` 中的网站源码并推送到 `main`。
2. 打开仓库的 **Actions**，查看 **Publish website to GitHub Pages**。
3. 等待检查、构建和发布全部变为绿色，再刷新网站。

也可以在该工作流页面点击 **Run workflow** 手动重新发布。首次配置时，仓库 **Settings → Pages → Build and deployment → Source** 应选择 **GitHub Actions**。

## 发布内容

只发布 `particle-site/out/` 中构建出的网页、脚本、图片和网页模型。Blender 源文件、依赖目录、本地验证结果和部署压缩包不包含在网站中。

发布流程使用锁定的依赖版本，并在构建前运行自动测试。只有检查和构建成功，才会发布新版网站。

## 网址路径

GitHub Pages 使用 `/Particle-site` 作为网址前缀。工作流从 GitHub Pages 配置中读取此前缀，通过 `NEXT_PUBLIC_BASE_PATH` 同时设置 Next.js 页面路径和示例素材路径。

本地开发或其他根目录托管不设置这个变量即可，仍使用原来的 `/` 地址。
