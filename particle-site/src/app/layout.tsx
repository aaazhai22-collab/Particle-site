import type { Metadata, Viewport } from 'next';
import '../style.css';

export const metadata: Metadata = {
  title: '粒子工坊 · Particle Studio',
  description: '实时粒子视觉工作台，导入图片与三维模型，编辑粒子动效与关键帧动画，支持 1080p60 和 4K30 高清视频导出。',
  icons: { icon: 'data:,' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#111116',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
