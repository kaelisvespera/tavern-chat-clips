const APPEARANCE_ATTRIBUTE = 'data-th-frozen-appearance';
const PSEUDO_ATTRIBUTE = 'data-th-frozen-pseudo';
let appearanceNumber = 0;

const INHERITED = `color font-family font-size font-style font-weight font-stretch font-variant
  font-feature-settings font-variation-settings font-optical-sizing line-height letter-spacing word-spacing
  text-align text-transform text-indent text-shadow white-space overflow-wrap word-break line-break hyphens
  direction writing-mode text-orientation
  list-style-type list-style-position list-style-image tab-size`.split(/\s+/);

const VISUAL = `display visibility opacity box-sizing background-color background-image background-repeat
  background-position background-size background-attachment background-origin background-clip
  background-blend-mode border-top border-right border-bottom border-left border-radius border-image border-collapse border-spacing
  outline box-shadow text-decoration text-decoration-thickness text-underline-offset vertical-align
  transform transform-origin translate rotate scale perspective filter backdrop-filter clip-path
  mask-image mask-size mask-position mask-repeat mix-blend-mode isolation object-fit object-position
  position z-index float clear overflow-x overflow-y aspect-ratio column-count column-width column-rule`.split(/\s+/);

const LAYOUT = `width height min-width min-height max-width max-height top right bottom left margin-top margin-right
  margin-bottom margin-left padding-top padding-right padding-bottom padding-left flex flex-flow
  align-items align-self align-content justify-items justify-self justify-content row-gap column-gap
  order grid-template-columns grid-template-rows grid-template-areas grid-auto-columns grid-auto-rows
  grid-auto-flow grid-column grid-row`.split(/\s+/);

const SVG = 'fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset paint-order'.split(' ');
const DEFAULTS = {
  'background-image': 'none', 'background-repeat': 'repeat', 'background-position': '0% 0%',
  'background-size': 'auto', 'background-attachment': 'scroll', 'background-origin': 'padding-box',
  'background-clip': 'border-box', 'background-blend-mode': 'normal', 'border-radius': '0px',
  'border-image': 'none', 'border-collapse': 'separate', 'border-spacing': '0px', 'box-shadow': 'none', 'text-decoration-thickness': 'auto',
  'text-underline-offset': 'auto', 'vertical-align': 'baseline', transform: 'none',
  translate: 'none', rotate: 'none', scale: 'none', perspective: 'none', filter: 'none',
  'backdrop-filter': 'none', 'clip-path': 'none', 'mask-image': 'none', 'mix-blend-mode': 'normal',
  isolation: 'auto', 'object-fit': 'fill', 'object-position': '50% 50%', position: 'static',
  'z-index': 'auto', float: 'none', clear: 'none', 'overflow-x': 'visible',
  'overflow-y': 'visible', 'aspect-ratio': 'auto', flex: '0 1 auto', 'flex-flow': 'row nowrap',
  'align-items': 'normal', 'align-self': 'auto', 'align-content': 'normal', 'justify-items': 'normal',
  'justify-self': 'auto', 'justify-content': 'normal', 'row-gap': 'normal', 'column-gap': 'normal',
  order: '0', 'grid-template-columns': 'none', 'grid-template-rows': 'none',
  'grid-template-areas': 'none', 'grid-auto-columns': 'auto', 'grid-auto-rows': 'auto',
  'grid-auto-flow': 'row', 'grid-row': 'auto', 'grid-column': 'auto', 'column-count': 'auto', 'column-width': 'auto',
};

function usesReaderScale(property, value, scaleText) {
  return scaleText && (property === 'font-size' || property === 'line-height') && /^\d+(?:\.\d+)?px$/.test(value);
}

function declarationValue(property, value, scaleText) {
  return usesReaderScale(property, value, scaleText) ? `calc(${value} * var(--th-reading-scale, 1))` : value;
}

function writeAppearance(target, computed, inherited, typedLayout, scaleText, { pseudo = false, svg = false } = {}) {
  for (const property of INHERITED) {
    const value = computed.getPropertyValue(property);
    if (value && (value !== inherited?.getPropertyValue(property) || target.getPropertyValue(property))) {
      target.setProperty(property, declarationValue(property, value, scaleText), 'important');
    }
  }

  for (const property of VISUAL) {
    const value = computed.getPropertyValue(property);
    const explicit = target.getPropertyValue(property);
    if (!value || (!explicit && (value === DEFAULTS[property] || /^(?:0px none)(?:\s|$)/.test(value)))) continue;
    if (!explicit && property === 'outline' && computed.outlineStyle === 'none') continue;
    if (!explicit && property.startsWith('mask-') && computed.maskImage === 'none') continue;
    if (!explicit && property === 'transform-origin' && computed.transform === 'none' && computed.rotate === 'none' && computed.scale === 'none') continue;
    target.setProperty(property, value, 'important');
  }

  for (const property of LAYOUT) {
    const explicit = target.getPropertyValue(property);
    if (!pseudo && explicit && !explicit.includes('var(')) continue;
    // Typed OM keeps auto, percentages and grid tracks before used pixel values are applied.
    const typed = typedLayout?.get(property)?.toString();
    if (!pseudo && !typed && (property === 'width' || property === 'height')) continue;
    const value = typed || computed.getPropertyValue(property);
    if (!value || value === DEFAULTS[property] || /^(?:normal|none)$/.test(value)) continue;
    if (value === 'auto' && !property.startsWith('margin-')) continue;
    target.setProperty(property, value, 'important');
  }

  if (svg) {
    for (const property of SVG) {
      const value = computed.getPropertyValue(property);
      if (value && (value !== inherited?.getPropertyValue(property) || target.getPropertyValue(property))) {
        target.setProperty(property, value, 'important');
      }
    }
  }
}

function freezeCanvas(source, target, computed) {
  if (!source.width || !source.height || computed.display === 'none' || computed.visibility !== 'visible') return;
  try {
    const src = source.toDataURL();
    if (src === 'data:,') return;
    const image = target.ownerDocument.createElement('img');
    for (const attribute of target.attributes) image.setAttribute(attribute.name, attribute.value);
    image.style.setProperty('width', computed.width, 'important');
    image.style.setProperty('height', computed.height, 'important');
    image.src = src;
    target.replaceWith(image);
  } catch {
    // The browser can display a canvas with cross-origin pixels that it cannot read back.
  }
}

/** Capture the current appearance before any asynchronous frame reads or prompts. */
export function freezeRenderedAppearance(live, cloned, { scaleText = true } = {}) {
  const view = live.ownerDocument.defaultView;
  if (!view) return;

  const marker = `${Date.now().toString(36)}-${(++appearanceNumber).toString(36)}`;
  cloned.setAttribute(APPEARANCE_ATTRIBUTE, marker);
  const scope = `[${APPEARANCE_ATTRIBUTE}="${marker}"]`;
  const sources = [live, ...live.querySelectorAll('*')];
  const targets = [cloned, ...cloned.querySelectorAll('*')];
  const inherited = new Map();
  const rules = [];
  const pseudoRule = cloned.ownerDocument.createElement('span');

  for (const [index, source] of sources.entries()) {
    const target = targets[index];
    if (!target?.style || source.localName === 'iframe' || source.closest('iframe,script,style,template')) continue;
    const computed = view.getComputedStyle(source);
    const parentStyle = inherited.get(source.parentElement);
    inherited.set(source, computed);
    writeAppearance(target.style, computed, parentStyle, source.computedStyleMap?.(), scaleText,
      { svg: source.namespaceURI === 'http://www.w3.org/2000/svg' });

    for (const pseudo of ['::before', '::after']) {
      const style = view.getComputedStyle(source, pseudo);
      const content = style.getPropertyValue('content');
      if (!content || content === 'none' || content === 'normal' || style.display === 'none') continue;
      pseudoRule.style.cssText = '';
      pseudoRule.style.setProperty('content', content, 'important');
      writeAppearance(pseudoRule.style, style, computed, null, scaleText, { pseudo: true });
      target.setAttribute(PSEUDO_ATTRIBUTE, String(index));
      const selector = index === 0 ? scope : `${scope} [${PSEUDO_ATTRIBUTE}="${index}"]`;
      // Prevent CSS strings with literal closing tags from ending the style element on serialization.
      rules.push(`${selector}${pseudo}{${pseudoRule.style.cssText.replace(/</g, '\\3c ')}}`);
    }

    if (source.localName === 'canvas' && source !== live) freezeCanvas(source, target, computed);
  }

  if (rules.length) {
    const stylesheet = cloned.ownerDocument.createElement('style');
    stylesheet.setAttribute('data-th-frozen-pseudos', '');
    stylesheet.textContent = rules.join('\n');
    const container = cloned.localName === 'html' ? cloned.querySelector('head') ?? cloned : cloned;
    container.appendChild(stylesheet);
  }
}
