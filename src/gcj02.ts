// WGS84 与 GCJ-02（高德等国内地图使用的坐标系）之间的换算。
// 程序内部统一保存 WGS84，只在显示到高德地图、或从高德地图取点时换算。
const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

export type LngLat = { lat: number; lon: number };

function outOfChina(lat: number, lon: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return r;
}

function transformLon(x: number, y: number): number {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return r;
}

export function wgs84ToGcj02(lat: number, lon: number): LngLat {
  if (outOfChina(lat, lon)) return { lat, lon };
  let dLat = transformLat(lon - 105, lat - 35);
  let dLon = transformLon(lon - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

// 正向换算不是线性的，这里用迭代求逆：反复修正，直到正向换算的结果与输入吻合
export function gcj02ToWgs84(lat: number, lon: number): LngLat {
  if (outOfChina(lat, lon)) return { lat, lon };
  let wLat = lat;
  let wLon = lon;
  for (let i = 0; i < 20; i++) {
    const g = wgs84ToGcj02(wLat, wLon);
    const dLat = g.lat - lat;
    const dLon = g.lon - lon;
    if (Math.abs(dLat) < 1e-10 && Math.abs(dLon) < 1e-10) break;
    wLat -= dLat;
    wLon -= dLon;
  }
  return { lat: wLat, lon: wLon };
}
