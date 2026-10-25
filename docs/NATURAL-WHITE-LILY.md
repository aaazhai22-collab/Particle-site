# 白百合 · 自然风蚀

记录日期：2026-10-25（北京时间）。本轮实现与真实验收已完成：Node 151/151、TypeScript 与 Vite 生产构建通过，最终入口为 `index-B7eFd2ri.js`；保留既有 Three.js 包体积提示。静态专项42/42、自然路径真实GPU19/19、既有GPU37/37、真实录像7/7通过。发布尚待实际部署工具结果，不将构建通过等同上线。

## 素材与入口

以用户提供的 `下载.png` 为形态和颜色参考，制作单朵完整立体百合：六片有厚度的长瓣、前后错位和翻卷，白 / 乳灰花瓣、淡绿花喉、淡绿花丝和棕色花药。黑色背景不建面；侧背面是依据花朵结构补建的立体近似，不宣称单张照片精确重建。

已生成 [white-lily-model.glb](../public/examples/white-lily-model.glb)：25个闭合网格、68,196顶点、136,292三角面、4,118,420字节。包含六片有厚度的花瓣、六组棕色花药与淡绿花丝、雌蕊及背部结构；颜色来自参考照片局部取样与乳白底色混合。元数据记录全部网格闭合、正体积、正确外法线、自包含且无图片背景平面，详见 [模型元数据](../public/examples/white-lily-model-metadata.json)。背面与遮挡区域为结构推定，不能据此承诺照片的精确重建。

默认加载“白百合 · 自然风蚀”示例，36秒渐隐回环；素材窗口保留旧粉花、百合、方鼎和图片等入口。点击同名**效果预设**保留当前素材，点击**白百合示例**才替换模型。主界面已实际验证：加载旧粉花后应用白百合预设，文件名仍为粉花；随后白百合示例可正常载入。模型与参考图下载链接分别核对为 `/examples/white-lily-model.glb` 和 `/examples/white-lily-reference.png`。扩散1.45、粒子大小1.1、泛光22%和36秒总时长的输入框与滑块同步正常。

## 自然退场与粒子短尾

此前只淡出后段旧 coil 的修复不足，本次在白百合和旧粉花微流分支**整段禁用连续 LineSegments 层，并删除额外 coil 位移**。主体与短尾都由 `Points` 构成，短尾采样同一粒子的真实历史路径；改变“粒子短尾”会实际改变画面。

退场顺序：主体与少量外围微动 → 花瓣不同区域错峰松动 / 稀疏 → 相关开放流场带走粒子 → 短尾碎散并逐粒降低可见度 → 黑场 → 反向聚合精确还原。粒子向外实际移动，不能仅对整张花朵或其透明度做变换。

局部漂移持续向前，随进度开放地向外运动，不在终点绕回起始轮廓。反向聚合由确定性的原位与进度重新求值；开启淡出时终点主体和尾点都不可见，关闭淡出仍保留空间碎点。六种通用效果、关键帧、相机、数量适配和现有录制接口继续保留。

## 真实验证与证据

| 检查 | 已完成结果 |
| --- | --- |
| 静态与交互 | [natural-static-test.json](../artifacts/natural-static-test.json)，42/42；单一最终画布、原色三维模型、正/侧/背/斜视、不同阶段连续变化均通过 |
| 全程无线层 | 白百合进度0 / .18 / .4 / .65 / .85 / .94 / 1，以及旧粉花0 / .4 / .65 / .85 / 1，均检查 `trails.visible=false`；尾层仅为Points |
| 端点与稳定 | 最终画布黑场 `nonblack=0`；同秒定位、暂停冻结、反向精确还原、36秒首末一致、改数量保留视角与进度通过 |
| 粒子短尾 | 控件确实改变实际画面；原形无尾迹，早中段有真实短尾，后段碎散淡出；关闭淡出仍保留可见空间碎点 |
| 自然路径GPU | [natural-gpu.json](../artifacts/natural-gpu.json)，19/19；生产shader实际编译，历史尾点无额外coil、持续正向漂移而非闭环、路径误差与头部误差均为0 |
| 局部有界范围 | GPU点样测试配置spread=0.6时，最大最终位移约0.9059模型单位；尾点到当前头部的最大距离约0.1781。该数值仅代表该测试配置 |
| 通用效果回归 | [natural-legacy-gpu.json](../artifacts/natural-legacy-gpu.json)，37/37；保留旧六模式及花瓣效果门控 |
| Node与构建 | 最终151/151、TypeScript与Vite构建通过；[Node日志](../artifacts/natural-node-tests.txt)，既有分包体积提示保留 |
| 本机短时渲染 | 静态专项实际180,000主体、1920×1080、spread1.45的活动短测为60渲染FPS；不是60秒全数量档位性能测试 |

环境：Windows / Chrome156、ANGLE / Intel UHD（0x46A3）/ Direct3D11、WebGL2；浏览器报告16 CPU线程、内存估计32GB（非物理内存确认）。测试视口918×668，最终画布1920×1080。静态专项于北京时间2026-10-25 21:50:40开始。

实际最终画布截图：[原形](../artifacts/petal-natural-p0.png)、[松动 .18](../artifacts/petal-natural-p018.png)、[中段 .4](../artifacts/petal-natural-p04.png)、[风蚀 .65](../artifacts/petal-natural-p065.png)、[碎点 .85](../artifacts/petal-natural-p085.png)、[后段 .94](../artifacts/petal-natural-p094.png)、[完全黑场](../artifacts/petal-natural-p1.png)、[侧面](../artifacts/petal-natural-side.png)、[背面](../artifacts/petal-natural-back.png)、[斜视](../artifacts/petal-natural-oblique.png)。

## 真实录像

[natural-recording-test.json](../artifacts/natural-recording-test.json) 7/7通过；[natural-white-lily.mp4](../artifacts/natural-white-lily.mp4) 是实际最终画布的1080p无声MP4 / H.264，16,097,056字节。有效录制计时11.2655秒，手动请求338帧；[容器样本解析](../artifacts/natural-video-inspection.json) 得到337个编码帧、11.2239秒解码时间线、平均编码30.0252 FPS，实际标识`avc1.42c02a`。请求帧数、有效计时、媒体时间与编码帧数分别记录，未用渲染FPS代替编码FPS。

23个录制渲染样本中前2个初始化值为0，其余21个为60–61渲染FPS，初始化低值保留。解码视频已检查末段短尾/碎点、5.1秒黑场、黑场后的逆向聚合，以及定位后的播放/暂停；这次视频黑场自身也为`nonblack=0`，平均亮度0。

## 首轮修正与限制

首轮视觉检查发现粒子漂移过大、部分移出画面，保留 [natural-static-first.json](../artifacts/natural-static-first.json)、[首轮 .4](../artifacts/petal-natural-first-p04.png) 与 [首轮 .65](../artifacts/petal-natural-first-p065.png)。随后缩短并约束travel范围，改为更局部的向外漂移，再重新执行上述静态、GPU和录像检查；旧图仅作失败与修正证据，不作为最终效果展示。

原先仅处理末段、保留前段coil的方案没有满足整段自然退场要求，本轮已从绘制类型与轨迹函数移除该来源。参考照片只能约束可见形态和颜色，静态参考不能确定完整时间运动，不承诺单图精确重建或逐帧1:1复现。

新shader的自动数量上限仍可达500,000，但依据本机真实活动样本适配；本轮没有重跑60秒全部数量档位，不能保证所有设备、所有视角或500k持续达到同样FPS。长时播放、多次导入和连续录像压力验证也不因本次通过自动视为完成。源码构建完成，原Sites发布及访问权限以主流程实际部署结果为准，尚不预填上线成功。
