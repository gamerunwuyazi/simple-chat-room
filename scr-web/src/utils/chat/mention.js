/**
 * 群聊 @ 气泡渲染
 * 只对「已转义的纯文本 HTML」做标记，不匹配标签内部，避免破坏 v-html 结构。
 */

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} html 已转义的内容（可以包含已生成的 <a> 链接）
 * @param {object} options
 * @param {string[]} options.nicknames 当前群可被 @ 的昵称集合
 * @param {string[]} options.selfNicknames 当前用户自己的昵称（含群昵称），命中则高亮为「@我」
 * @returns {string}
 */
export function highlightMentions(html, { nicknames = [], selfNicknames = [] } = {}) {
  if (!html || typeof html !== 'string') return html;

  const candidates = Array.from(new Set(nicknames.filter(Boolean)))
    .sort((a, b) => b.length - a.length);

  if (candidates.length === 0) return html;

  // name 在 replace 中是「已转义」的片段，所以自我昵称同样转义后比较
  const selfSet = new Set(selfNicknames.filter(Boolean).map((name) => escapeHtml(String(name))));

  // 昵称是用户自填的，必须做正则转义，否则 `a(b`、`*` 之类会直接抛 SyntaxError 打断渲染
  const escapedNames = candidates
    .map((name) => escapeRegExp(escapeHtml(name)))
    .sort((a, b) => b.length - a.length);

  let pattern;
  try {
    // 以「开始或空白或标签结束」为左边界，右侧不紧跟昵称字符（用负向断言排除误伤）
    pattern = new RegExp(`(^|[\\s>])@(${escapedNames.join('|')})(?![\\w\\u4e00-\\u9fa5])`, 'g');
  } catch (e) {
    return html;
  }

  return html.replace(pattern, (match, prefix, name) => {
    const isSelf = selfSet.has(name);
    const cls = isSelf ? 'at-mention at-mention-self' : 'at-mention';
    return `${prefix}<span class="${cls}">@${name}</span>`;
  });
}
