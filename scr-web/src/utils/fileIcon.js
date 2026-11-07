// 文件类型 → Font Awesome 6 图标类名。
// 前端统一用图标字体渲染文件图标，避免 emoji 在缺少 emoji 字体的环境显示成方框。
const EXT_ICON_MAP = {
  // 文档
  txt: 'fa-file-lines',
  rtf: 'fa-file-lines',
  md: 'fa-file-lines',
  pdf: 'fa-file-pdf',
  doc: 'fa-file-word',
  docx: 'fa-file-word',
  // 表格
  xls: 'fa-file-excel',
  xlsx: 'fa-file-excel',
  csv: 'fa-file-csv',
  // 演示文稿
  ppt: 'fa-file-powerpoint',
  pptx: 'fa-file-powerpoint',
  // 压缩包
  zip: 'fa-file-zipper',
  rar: 'fa-file-zipper',
  '7z': 'fa-file-zipper',
  tar: 'fa-file-zipper',
  gz: 'fa-file-zipper',
  // 图片
  jpg: 'fa-file-image',
  jpeg: 'fa-file-image',
  png: 'fa-file-image',
  gif: 'fa-file-image',
  bmp: 'fa-file-image',
  webp: 'fa-file-image',
  svg: 'fa-file-image',
  // 音频
  mp3: 'fa-file-audio',
  wav: 'fa-file-audio',
  ogg: 'fa-file-audio',
  flac: 'fa-file-audio',
  // 视频
  mp4: 'fa-file-video',
  avi: 'fa-file-video',
  mov: 'fa-file-video',
  wmv: 'fa-file-video',
  flv: 'fa-file-video',
  // 可执行 / 脚本
  exe: 'fa-gear',
  dll: 'fa-gear',
  bat: 'fa-gear',
  sh: 'fa-gear',
  // 代码
  js: 'fa-file-code',
  ts: 'fa-file-code',
  html: 'fa-file-code',
  css: 'fa-file-code',
  php: 'fa-file-code',
  py: 'fa-file-code',
  java: 'fa-file-code',
  c: 'fa-file-code',
  cpp: 'fa-file-code',
  cs: 'fa-file-code',
  go: 'fa-file-code',
  rb: 'fa-file-code',
  swift: 'fa-file-code',
  kt: 'fa-file-code'
};

/**
 * 根据文件名（或扩展名）返回 Font Awesome 图标类名，未识别时返回通用文件图标。
 * @param {string} filename
 * @returns {string} 例如 'fa-file-pdf'
 */
export function getFileIconClass(filename) {
  if (!filename) return 'fa-file';
  const ext = String(filename).split('.').pop()?.toLowerCase() || '';
  return EXT_ICON_MAP[ext] || 'fa-file';
}
