/** Browser pass-through replacement for the native sharp stub: parses raster headers and keeps original bytes. */
const sharp = (function () {
  function detectFormat(bytes) {
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
    if (bytes.length > 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
    if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
    return 'png'
  }
  function dimensions(bytes, format) {
    try {
      if (format === 'png' && bytes.length > 24) return { width: ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0, height: ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0 }
      if (format === 'gif' && bytes.length > 10) return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) }
      if (format === 'webp' && bytes.length > 30) {
        if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) return { width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) }
      }
      if (format === 'jpeg') {
        let offset = 2
        while (offset + 9 < bytes.length) {
          if (bytes[offset] !== 0xff) { offset++; continue }
          const marker = bytes[offset + 1]
          if (marker >= 0xc0 && marker <= 0xc3) return { height: (bytes[offset + 5] << 8) | bytes[offset + 6], width: (bytes[offset + 7] << 8) | bytes[offset + 8] }
          const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
          offset += 2 + (length > 0 ? length : 2)
        }
      }
    } catch (error) {}
    return { width: 1024, height: 1024 }
  }
  return function sharp(input) {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input)
    const format = detectFormat(data)
    const size = dimensions(data, format)
    const api = {
      metadata: async () => ({ format, width: size.width, height: size.height, pages: 1, depth: 'uchar', space: 'srgb', hasAlpha: format !== 'jpeg', channels: 4 }),
      rotate: () => api,
      toColourspace: () => api,
      resize: () => api,
      toFormat: () => api,
      jpeg: () => api,
      png: () => api,
      webp: () => api,
      raw: () => api,
      toBuffer: async (options) => {
        const bytes = new Uint8Array(data)
        if (options && options.resolveWithObject) return { data: bytes, info: { width: size.width, height: size.height, format, channels: 4, size: bytes.length } }
        return bytes
      }
    }
    return api
  }
})()
sharp.cache = () => {}
sharp.concurrency = () => {}
sharp.simd = () => {}
