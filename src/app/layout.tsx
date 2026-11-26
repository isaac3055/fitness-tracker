import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Fitness Tracker · 健康有迹可循", description: "训练、饮食与身体数据，在一处管理。" };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
