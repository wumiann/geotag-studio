/// <reference types="vite/client" />

// 高德官方 JS API（运行时从 webapi.amap.com 加载，没有安装类型包）
interface Window {
  AMap?: any;
  _AMapSecurityConfig?: { securityJsCode: string };
}
