// 앱 아이콘(PNG)을 외부 의존성 없이 생성한다.  node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const BG = [31, 79, 209]
const FG = [255, 255, 255]

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

// 단위 좌표(0~1)에서 열차 아이콘의 색을 돌려준다. null = 투명
function sample(x, y, { rounded, scale }) {
  if (rounded && !inRoundRect(x, y, 0, 0, 1, 1, 0.22)) return null
  // 안전 영역에 맞춰 중심 기준으로 확대/축소
  const u = (x - 0.5) / scale + 0.5
  const v = (y - 0.5) / scale + 0.5
  let c = BG
  if (inRoundRect(u, v, 0.28, 0.2, 0.72, 0.68, 0.08)) {
    c = FG
    if (inRoundRect(u, v, 0.34, 0.27, 0.66, 0.43, 0.03)) c = BG
    if ((u - 0.38) ** 2 + (v - 0.58) ** 2 <= 0.04 ** 2) c = BG
    if ((u - 0.62) ** 2 + (v - 0.58) ** 2 <= 0.04 ** 2) c = BG
  }
  if (inRoundRect(u, v, 0.24, 0.74, 0.76, 0.78, 0.02)) c = FG
  return c
}

function crc32(buf) {
  let c,
    crc = ~0
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return ~crc >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, opts) {
  const SS = 3
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const col = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, opts)
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 255 }
        }
      const n = SS * SS
      const o = y * (size * 4 + 1) + 1 + x * 4
      const cnt = a / 255 || 1
      raw[o] = Math.round(r / cnt); raw[o + 1] = Math.round(g / cnt); raw[o + 2] = Math.round(b / cnt); raw[o + 3] = Math.round(a / n)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

mkdirSync('public/icons', { recursive: true })
writeFileSync('public/icons/icon-192.png', png(192, { rounded: true, scale: 1 }))
writeFileSync('public/icons/icon-512.png', png(512, { rounded: true, scale: 1 }))
writeFileSync('public/icons/maskable-512.png', png(512, { rounded: false, scale: 0.8 }))
writeFileSync('public/icons/apple-touch-icon.png', png(180, { rounded: false, scale: 0.9 }))
console.log('아이콘 생성 완료')
