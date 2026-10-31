import test from 'node:test';
import assert from 'node:assert/strict';
import {renderSmoothNumber} from '../web/numeric-motion.js';

function fakeDom(reduce = false) {
  const animations = [];
  const createElement = () => ({
    children: [], attrs: {}, className: '', textContent: '',
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = [...children]; },
    setAttribute(name, value) { this.attrs[name] = value; },
    getAnimations() { return []; },
    animate(frames, config) { animations.push({frames, config}); },
  });
  const documentMock = {createElement, body: {classList: {contains:()=>reduce}}};
  return {documentMock, animations, node:createElement()};
}

test('digits are updated immediately while the clock animation is decorative', () => {
  const {documentMock, animations, node} = fakeDom();
  const oldDocument=globalThis.document, oldWindow=globalThis.window;
  globalThis.document=documentMock;
  globalThis.window={matchMedia:()=>({matches:false})};
  try {
    renderSmoothNumber(node, '00:00:10');
    const first = node.children[0].children[0];
    assert.equal(node.attrs['aria-label'],'00:00:10');
    assert.equal(first.children.length,8);
    renderSmoothNumber(node, '00:00:09');
    assert.equal(node.attrs['aria-label'],'00:00:09');
    assert.equal(first.children[6].textContent,'0');
    assert.equal(first.children[7].textContent,'9');
    assert.equal(animations.length,2);
  } finally {
    globalThis.document=oldDocument;
    globalThis.window=oldWindow;
  }
});

test('stopwatch hundredths refresh without animation or recreating the DOM', () => {
  const {documentMock, animations, node} = fakeDom();
  const oldDocument=globalThis.document, oldWindow=globalThis.window;
  globalThis.document=documentMock;
  globalThis.window={matchMedia:()=>({matches:false})};
  try {
    renderSmoothNumber(node,'00:00:01.12',{fractionDigits:2});
    const container=node.children[0];
    renderSmoothNumber(node,'00:00:01.19',{fractionDigits:2});
    assert.equal(container,node.children[0]);
    assert.equal(container.children[1].textContent,'.19');
    assert.equal(animations.length,0);
  } finally {
    globalThis.document=oldDocument;
    globalThis.window=oldWindow;
  }
});

test('reduced motion preference bypasses animation', () => {
  const {documentMock, animations, node} = fakeDom(true);
  const oldDocument=globalThis.document, oldWindow=globalThis.window;
  globalThis.document=documentMock;
  globalThis.window={matchMedia:()=>({matches:false})};
  try {
    renderSmoothNumber(node,'10');
    renderSmoothNumber(node,'11');
    assert.equal(animations.length,0);
    assert.equal(node.attrs['aria-label'],'11');
  } finally {
    globalThis.document=oldDocument;
    globalThis.window=oldWindow;
  }
});
