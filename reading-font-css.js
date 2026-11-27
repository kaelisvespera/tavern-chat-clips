const BODY_FONT_PROPERTIES = ['font-family', 'font-weight', 'font-style'];
const FACE_DESCRIPTORS = new Set([
  'font-family', 'src', 'font-style', 'font-weight', 'font-stretch', 'font-width', 'font-display', 'unicode-range',
  'font-feature-settings', 'font-variation-settings', 'ascent-override', 'descent-override', 'line-gap-override', 'size-adjust',
]);

const QUOTED_VALUE = String.raw`"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'`;
const URL_VALUE = String.raw`url\(\s*(?:${QUOTED_VALUE}|((?:\\[\s\S]|[^"'()\\\s])+))\s*\)`;
const IMPORT_VALUE = new RegExp(String.raw`^(?:${URL_VALUE}|${QUOTED_VALUE})`, 'i');
const SOURCE_TOKEN = new RegExp(String.raw`${URL_VALUE}|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'`, 'gi');

function decodeCssValue(value) {
  return value.replace(/\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\n\r\f])|([\s\S]))/gi,
    (_, hex, lineBreak, character) => {
      if (!hex) return character ?? '';
      const codepoint = Number.parseInt(hex, 16);
      return codepoint > 0 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : '\ufffd';
    });
}

function sourceUrl(input, baseUrl, allowFontData = false) {
  const url = new URL(decodeCssValue(input), baseUrl);
  if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  if (allowFontData && url.protocol === 'data:'
    && /^data:(?:font\/|application\/(?:font-|x-font-|octet-stream))/i.test(url.href)) return url.href;
  throw new Error('字体样式仅支持 HTTP(S) 和内联字体文件。');
}

function fontAssets(rules) {
  const imports = [];
  const fontFaces = [];
  for (const rule of rules) {
    if (rule.type === 'font-face') {
      const declarations = rule.declarations.filter(
        declaration => declaration.type === 'declaration' && FACE_DESCRIPTORS.has(declaration.property.toLowerCase()),
      );
      if (declarations.some(declaration => declaration.property.toLowerCase() === 'font-family')
        && declarations.some(declaration => declaration.property.toLowerCase() === 'src')) {
        fontFaces.push({ ...rule, declarations });
      }
    } else if (rule.type === 'import') {
      const match = IMPORT_VALUE.exec(rule.import.trim());
      if (match) imports.push(match.slice(1).find(value => value !== undefined));
    }
  }
  return { imports, fontFaces };
}

export function parseReadingFontCss(source, parser, ownerDoc) {
  const rules = parser.parse(source).stylesheet.rules;
  const style = ownerDoc.createElement('div').style;
  for (const rule of rules) {
    if (rule.type !== 'rule' || !rule.selectors.some(selector => selector.trim().toLowerCase() === 'body')) continue;
    for (const declaration of rule.declarations) {
      if (declaration.type !== 'declaration') continue;
      const property = declaration.property.toLowerCase();
      if (!BODY_FONT_PROPERTIES.includes(property)) continue;
      const important = /!\s*important\s*$/i;
      const priority = important.test(declaration.value) ? 'important' : '';
      if (style.getPropertyPriority(property) && !priority) continue;
      style.setProperty(property, declaration.value.replace(important, '').trim(), priority);
    }
  }
  const declarations = new Map();
  for (const property of BODY_FONT_PROPERTIES) {
    const value = style.getPropertyValue(property);
    if (value) declarations.set(property, value);
  }
  return { ...fontAssets(rules), declarations };
}

export async function loadReadingFontFaces(parsed, parser, { baseUrl, fetch }) {
  const seen = new Set();
  async function resolveAssets({ imports, fontFaces }, stylesheetUrl) {
    const imported = await Promise.all(imports.map(async href => {
      const url = sourceUrl(href, stylesheetUrl);
      if (seen.has(url)) return [];
      seen.add(url);
      const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`字体样式加载失败（HTTP ${response.status}）。`);
      const rules = parser.parse(await response.text()).stylesheet.rules;
      return resolveAssets(fontAssets(rules), response.url || url);
    }));
    return imported.flat().concat(fontFaces.map(rule => ({
      ...rule,
      declarations: rule.declarations.map(declaration => {
        if (declaration.property.toLowerCase() !== 'src') return declaration;
        const value = declaration.value.replace(SOURCE_TOKEN, (token, doubleQuoted, singleQuoted, bare) => {
          const href = doubleQuoted ?? singleQuoted ?? bare;
          return href === undefined ? token : `url(${JSON.stringify(sourceUrl(href, stylesheetUrl, true))})`;
        });
        return { ...declaration, value };
      }),
    })));
  }

  const rules = await resolveAssets(parsed, baseUrl);
  return parser.stringify({ type: 'stylesheet', stylesheet: { rules } }, { compress: true }).replace(/</g, '\\3c ');
}

export function selectReadingFontFaces(faces, text, parser) {
  if (!faces.includes('unicode-range:')) return faces;
  const characters = Array.from(new Set(Array.from(text, character => character.codePointAt(0))))
    .sort((a, b) => a - b);

  function intersects(start, end) {
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (characters[middle] < start) low = middle + 1;
      else high = middle;
    }
    return characters[low] <= end;
  }

  const stylesheet = parser.parse(faces);
  stylesheet.stylesheet.rules = stylesheet.stylesheet.rules.filter(rule => {
    const unicode = rule.declarations?.find(entry => entry.property?.toLowerCase() === 'unicode-range');
    if (!unicode) return true;
    return unicode.value.split(',').some(range => {
      const match = /^u\+([\da-f?]+)(?:-([\da-f]+))?$/i.exec(range.trim());
      if (!match) return true;
      const start = Number.parseInt(match[1].replace(/\?/g, '0'), 16);
      const end = Number.parseInt(match[2] ?? match[1].replace(/\?/g, 'f'), 16);
      return intersects(start, end);
    });
  });
  return parser.stringify(stylesheet, { compress: true }).replace(/</g, '\\3c ');
}
