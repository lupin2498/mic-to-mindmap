/* Sơ đồ tư duy SVG tương tác: bố cục hai phía (điện thoại cầm dọc: một phía, nút gốc ở trên cùng, vừa bề ngang màn
   hình), kéo/zoom (chuột, một ngón, chụm hai ngón), chọn, sửa chữ, thu gọn nhánh, xuất SVG/PNG.
   options.readOnly = true: chỉ xem (dùng cho bản xem trước lúc đang nói). */
(function (global) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const PALETTE = ['#4f46e5', '#0891b2', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#0d9488', '#ca8a04', '#2563eb'];
  const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
  const FONT = `13px ${FONT_FAMILY}`;
  const ROOT_FONT = `bold 15px ${FONT_FAMILY}`;
  const PAD_X = 12, PAD_Y = 7, LINE_H = 17, ROOT_LINE_H = 20, MAX_W = 220, ROOT_MAX_W = 260;
  const LEVEL_GAP = 64, V_GAP = 10, MAX_LINES = 5;
  // Điện thoại cầm dọc: nút hẹp hơn, các cấp sát nhau hơn để cả ba cấp vừa bề ngang màn hình mà chữ vẫn đọc được
  const NARROW_MAX_W = 150, NARROW_ROOT_MAX_W = 110, NARROW_LEVEL_GAP = 26, NARROW_MAX_LINES = 7;

  const measureCanvas = document.createElement('canvas').getContext('2d');
  function textWidth(text, font) {
    measureCanvas.font = font;
    return measureCanvas.measureText(text).width;
  }
  function wrap(text, font, maxWidth, maxLines) {
    const limit = maxLines || MAX_LINES;
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, font) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    if (lines.length > limit) {
      const kept = lines.slice(0, limit);
      kept[limit - 1] = kept[limit - 1].replace(/\s*\S*$/, '') + '…';
      return kept;
    }
    return lines.length ? lines : [''];
  }
  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const key in attrs) if (attrs[key] !== undefined && attrs[key] !== null) node.setAttribute(key, attrs[key]);
    if (parent) parent.appendChild(node);
    return node;
  }
  function tint(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  let idSeq = 1;
  function clone(node, depth) {
    return {
      id: idSeq++,
      title: String((node && node.title) || ''),
      collapsed: false,
      depth,
      children: ((node && node.children) || []).map((c) => clone(c, depth + 1)),
    };
  }

  class MindMap {
    constructor(container, options) {
      this.container = container;
      this.options = options || {};
      this.readOnly = !!this.options.readOnly;
      this.tree = null;
      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.selected = null;
      this.nodes = [];
      this.svg = el('svg', { xmlns: NS }, container);
      this.viewport = el('g', {}, this.svg);
      this.linkLayer = el('g', {}, this.viewport);
      this.nodeLayer = el('g', {}, this.viewport);
      this._bindEvents();
    }

    // ------------------------------------------------------------ dữ liệu
    setTree(tree) {
      idSeq = 1;
      this.tree = tree ? clone(tree, 0) : null;
      this.selected = null;
      this.render();
      this.fit();
    }
    getTree() {
      const strip = (n) => ({ title: n.title, children: n.children.map(strip) });
      return this.tree ? strip(this.tree) : null;
    }
    _changed() {
      if (typeof this.options.onChange === 'function') this.options.onChange(this.getTree());
    }

    // ------------------------------------------------------------ bố cục
    _size(node) {
      const isRoot = node.depth === 0;
      const maxWidth = this.oneSided ? (isRoot ? NARROW_ROOT_MAX_W : NARROW_MAX_W) : (isRoot ? ROOT_MAX_W : MAX_W);
      node.lines = wrap(node.title || (isRoot ? 'Cuộc họp' : '…'), isRoot ? ROOT_FONT : FONT, maxWidth,
        this.oneSided ? NARROW_MAX_LINES : MAX_LINES);
      const lineH = isRoot ? ROOT_LINE_H : LINE_H;
      const width = Math.max(...node.lines.map((l) => textWidth(l, isRoot ? ROOT_FONT : FONT)));
      node.w = Math.ceil(width) + PAD_X * 2 + (isRoot ? 8 : 0);
      node.h = node.lines.length * lineH + PAD_Y * 2 + (isRoot ? 6 : 0);
      node.lineH = lineH;
    }
    _visibleChildren(node) {
      return node.collapsed ? [] : node.children;
    }
    _narrow() {
      // tính theo cửa sổ, không theo khung: trên máy tính khung sơ đồ nằm trong một cột hẹp nhưng vẫn đủ chỗ cho hai phía
      return window.innerWidth < 600;
    }
    _subtreeHeight(node) {
      this._size(node);
      const kids = this._visibleChildren(node);
      if (!kids.length) {
        node.sh = node.h;
        return node.sh;
      }
      let total = 0;
      for (const kid of kids) total += this._subtreeHeight(kid);
      total += V_GAP * (kids.length - 1);
      node.sh = Math.max(node.h, total);
      return node.sh;
    }
    layout() {
      this.nodes = [];
      if (!this.tree) return;
      const root = this.tree;
      // Màn hình hẹp (điện thoại cầm dọc): dồn mọi nhánh về một phía, nút gốc nằm trên cùng bên trái, các nhánh
      // xếp dần xuống dưới. Sơ đồ vừa bề ngang màn hình, đọc từ trên xuống và chỉ phải kéo lên xuống.
      // Chia hai phía thì cả hai bên đều bị cắt.
      this.oneSided = this._narrow();
      this._size(root);
      root.x = -root.w / 2;
      root.y = -root.h / 2;
      root.side = 0;
      root.color = '#4f46e5';
      this.nodes.push(root);
      const sides = { 1: [], '-1': [] };
      const gap = this.oneSided ? NARROW_LEVEL_GAP : LEVEL_GAP;
      root.children.forEach((child, index) => {
        child.side = this.oneSided || index % 2 === 0 ? 1 : -1;
        child.color = PALETTE[index % PALETTE.length];
        sides[child.side].push(child);
      });
      if (root.collapsed) return;
      for (const side of [1, -1]) {
        const kids = sides[side];
        if (!kids.length) continue;
        const levelWidth = {};
        const measure = (node) => {
          this._subtreeHeight(node);
          const walk = (n) => {
            levelWidth[n.depth] = Math.max(levelWidth[n.depth] || 0, n.w);
            for (const k of this._visibleChildren(n)) walk(k);
          };
          walk(node);
        };
        kids.forEach(measure);
        const offsets = { 1: root.w / 2 + gap };
        for (let d = 1; d < 12; d++) {
          if (levelWidth[d] === undefined) break;
          offsets[d + 1] = offsets[d] + levelWidth[d] + gap;
        }
        let total = kids.reduce((sum, k) => sum + k.sh, 0) + V_GAP * (kids.length - 1);
        let top = -total / 2;
        const place = (node, startY, color) => {
          node.side = side;
          node.color = node.color || color;
          const inner = offsets[node.depth];
          node.x = side === 1 ? inner : -inner - node.w;
          node.y = startY + node.sh / 2 - node.h / 2;
          this.nodes.push(node);
          let cursor = startY;
          for (const kid of this._visibleChildren(node)) {
            place(kid, cursor, node.color);
            cursor += kid.sh + V_GAP;
          }
        };
        for (const kid of kids) {
          place(kid, top, kid.color);
          top += kid.sh + V_GAP;
        }
        // một phía: nút gốc ngang hàng với nhánh đầu tiên thay vì nằm giữa chiều cao (sơ đồ dài thì giữa nằm ngoài màn hình)
        if (this.oneSided) root.y = kids[0].y + kids[0].h / 2 - root.h / 2;
      }
    }

    // ------------------------------------------------------------- vẽ
    render() {
      this.layout();
      this.linkLayer.innerHTML = '';
      this.nodeLayer.innerHTML = '';
      if (!this.tree) return;
      const byId = new Map(this.nodes.map((n) => [n.id, n]));
      for (const node of this.nodes) {
        if (node.depth === 0) continue;
        const parent = this._parentOf(node);
        if (!parent || !byId.has(parent.id)) continue;
        const start = parent.depth === 0
          ? { x: node.side === 1 ? parent.x + parent.w : parent.x, y: parent.y + parent.h / 2 }
          : { x: node.side === 1 ? parent.x + parent.w : parent.x, y: parent.y + parent.h / 2 };
        const end = { x: node.side === 1 ? node.x : node.x + node.w, y: node.y + node.h / 2 };
        const dx = (end.x - start.x) / 2;
        el('path', {
          class: 'mm-link',
          d: `M ${start.x} ${start.y} C ${start.x + dx} ${start.y}, ${end.x - dx} ${end.y}, ${end.x} ${end.y}`,
          stroke: node.color, fill: 'none', 'stroke-width': node.depth === 1 ? 2.5 : 1.8, opacity: 0.85,
        }, this.linkLayer);
      }
      for (const node of this.nodes) this._drawNode(node);
    }
    _drawNode(node) {
      const isRoot = node.depth === 0;
      const g = el('g', {
        class: `mm-node${isRoot ? ' root' : ''}${this.selected === node ? ' selected' : ''}`,
        transform: `translate(${node.x}, ${node.y})`, 'data-id': node.id,
      }, this.nodeLayer);
      const fill = isRoot ? node.color : node.depth === 1 ? tint(node.color, 0.14) : '#ffffff';
      el('rect', {
        width: node.w, height: node.h, rx: isRoot ? 14 : 9, fill, stroke: this.selected === node ? '#111827' : node.color,
        'stroke-width': this.selected === node ? 2.5 : 1.5,
      }, g);
      const text = el('text', {
        x: PAD_X + (isRoot ? 4 : 0), y: PAD_Y + (isRoot ? 3 : 0) + node.lineH * 0.75,
        'font-family': FONT_FAMILY, 'font-size': isRoot ? 15 : 13, 'font-weight': isRoot ? 700 : 400,
        fill: isRoot ? '#ffffff' : '#111827',
      }, g);
      node.lines.forEach((line, i) => {
        const span = el('tspan', { x: PAD_X + (isRoot ? 4 : 0), dy: i === 0 ? 0 : node.lineH }, text);
        // Giữ dấu cách ở chỗ xuống dòng: không có nó thì chữ đọc ra (trình đọc màn hình, sao chép, tìm trong file SVG
        // xuất ra) bị dính liền, kiểu "sản phẩmmới". Dòng nào cũng đặt lại x nên dấu cách cuối dòng không hiện ra.
        span.textContent = i < node.lines.length - 1 ? `${line} ` : line;
      });
      if (node.children.length) {
        const cx = node.side === -1 ? -8 : node.w + 8;
        const toggle = el('g', { class: 'mm-toggle', transform: `translate(${cx}, ${node.h / 2})` }, g);
        el('circle', { r: 7, fill: '#fff', stroke: node.color, 'stroke-width': 1.5 }, toggle);
        const label = el('text', { 'text-anchor': 'middle', y: 3.5, 'font-size': 10, 'font-family': FONT_FAMILY, fill: '#374151' }, toggle);
        label.textContent = node.collapsed ? String(node.children.length) : '−';
        toggle.addEventListener('mousedown', (e) => e.stopPropagation());
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          node.collapsed = !node.collapsed;
          this.render();
        });
      }
      if (this.readOnly) return;
      g.addEventListener('click', (e) => {
        e.stopPropagation();
        this.select(node);
      });
      g.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this.edit(node);
      });
    }
    _parentOf(target) {
      const find = (node) => {
        for (const kid of node.children) {
          if (kid === target) return node;
          const found = find(kid);
          if (found) return found;
        }
        return null;
      };
      return this.tree ? find(this.tree) : null;
    }

    // ----------------------------------------------------------- tương tác
    _applyTransform() {
      this.viewport.setAttribute('transform', `translate(${this.tx}, ${this.ty}) scale(${this.scale})`);
    }
    _bounds() {
      if (!this.nodes.length) return { x: 0, y: 0, w: 1, h: 1 };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of this.nodes) {
        minX = Math.min(minX, n.x - 12); minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + n.w + 12); maxY = Math.max(maxY, n.y + n.h);
      }
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
    fit() {
      const rect = this.container.getBoundingClientRect();
      const b = this._bounds();
      const pad = 30;
      if (!rect.width || !rect.height) return; // khung đang ẩn, sẽ fit lại khi hiện
      if (this.oneSided) {
        // Điện thoại cầm dọc: thu cho vừa bề ngang (không nhỏ quá mức đọc được), bắt đầu từ nút gốc ở trên cùng;
        // sơ đồ cao hơn khung thì kéo lên xuống, thấp hơn khung thì đặt giữa
        const edge = 6;
        let fitWidth = (rect.width - edge * 2) / b.w;
        if (!isFinite(fitWidth) || fitWidth <= 0) fitWidth = 1;
        this.scale = Math.max(0.55, Math.min(fitWidth, 1.15));   // sơ đồ ba cấp luôn vừa; sâu hơn thì kéo ngang
        this.tx = edge - b.x * this.scale;
        const height = b.h * this.scale;
        this.ty = height <= rect.height - edge * 2 ? (rect.height - height) / 2 - b.y * this.scale : edge - b.y * this.scale;
        this._applyTransform();
        return;
      }
      let scale = Math.min((rect.width - pad * 2) / b.w, (rect.height - pad * 2) / b.h, 1.4);
      if (!isFinite(scale) || scale <= 0) scale = 1;
      // Máy tính: khung sơ đồ có thể nằm trong một cột hẹp nhưng vẫn phải thấy toàn bộ bản đồ
      const minScale = 0.15;
      this.scale = Math.max(minScale, scale);
      this.tx = rect.width / 2 - (b.x + b.w / 2) * this.scale;
      this.ty = rect.height / 2 - (b.y + b.h / 2) * this.scale;
      if (this.scale === minScale && scale < minScale) {
        // bản đồ quá lớn so với khung: căn theo nút gốc thay vì căn toàn bộ
        const root = this.nodes[0];
        this.tx = rect.width / 2 - (root.x + root.w / 2) * this.scale;
        this.ty = rect.height / 2 - (root.y + root.h / 2) * this.scale;
      }
      this._applyTransform();
    }
    zoom(factor, cx, cy) {
      const rect = this.container.getBoundingClientRect();
      const px = cx === undefined ? rect.width / 2 : cx;
      const py = cy === undefined ? rect.height / 2 : cy;
      const next = Math.min(4, Math.max(0.1, this.scale * factor));
      this.tx = px - (px - this.tx) * (next / this.scale);
      this.ty = py - (py - this.ty) * (next / this.scale);
      this.scale = next;
      this._applyTransform();
    }
    _bindEvents() {
      const c = this.container;
      let dragging = false, last = null, moved = false, downOnNode = false;
      c.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragging = true; moved = false; last = { x: e.clientX, y: e.clientY };
        downOnNode = !!(e.target.closest && e.target.closest('.mm-node'));
        c.classList.add('dragging');
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - last.x, dy = e.clientY - last.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        this.tx += dx; this.ty += dy; last = { x: e.clientX, y: e.clientY };
        this._applyTransform();
      });
      window.addEventListener('mouseup', () => {
        // Chỉ bỏ chọn khi nhấp vào nền. Nhấp vào nút mà vẽ lại ngay ở mouseup thì phần tử bị gỡ khỏi DOM
        // trước khi trình duyệt phát click/dblclick, khiến chuột không chọn và không sửa được nút.
        if (dragging && !moved && !downOnNode) this.select(null);
        dragging = false; c.classList.remove('dragging');
      });
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = c.getBoundingClientRect();
        this.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
      }, { passive: false });
      let touch = null, pinch = 0;
      const spread = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      c.addEventListener('touchstart', (e) => {
        if (e.touches.length === 1) { touch = { x: e.touches[0].clientX, y: e.touches[0].clientY }; pinch = 0; }
        else if (e.touches.length === 2) { touch = null; pinch = spread(e); }
      }, { passive: true });
      c.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && pinch > 0) {
          // chụm/xòe hai ngón: phóng to thu nhỏ quanh điểm giữa hai ngón
          e.preventDefault();
          const rect = c.getBoundingClientRect();
          const now = spread(e);
          if (now > 0) {
            this.zoom(now / pinch, (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left,
              (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top);
            pinch = now;
          }
          return;
        }
        if (!touch || e.touches.length !== 1) return;
        e.preventDefault();
        this.tx += e.touches[0].clientX - touch.x; this.ty += e.touches[0].clientY - touch.y;
        touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this._applyTransform();
      }, { passive: false });
      c.addEventListener('touchend', (e) => {
        pinch = 0;
        // nhấc một trong hai ngón: ngón còn lại tiếp tục kéo từ vị trí hiện tại, không giật về vị trí cũ
        touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      });
      // xoay máy/đổi cỡ cửa sổ: bố cục một phía hay hai phía tùy bề rộng nên phải vẽ lại. Chỉ chiều cao đổi (thanh địa
      // chỉ ẩn/hiện khi cuộn trang, bàn phím ảo mở lúc đang sửa chữ trong nút) thì giữ nguyên mức phóng to người dùng
      // đã chọn và ô đang sửa. Đo bề ngang khung nhìn bố cục: innerWidth đổi theo cả lúc trình duyệt di động thu phóng.
      let lastWidth = document.documentElement.clientWidth;
      window.addEventListener('resize', () => {
        const width = document.documentElement.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        if (this.tree) { this.render(); this.fit(); }
      });
    }
    select(node) {
      if (this.selected === node) return; // không vẽ lại giữa hai lần nhấp của một cú nhấp đúp
      this.selected = node;
      this.render();
    }
    edit(node) {
      if (!node) return;
      const old = this.container.querySelector('.mm-editor');
      if (old) old.remove();
      const editor = document.createElement('textarea');
      editor.className = 'mm-editor';
      editor.value = node.title;
      const left = this.tx + node.x * this.scale, top = this.ty + node.y * this.scale;
      editor.style.left = `${left}px`; editor.style.top = `${top}px`;
      editor.style.width = `${Math.max(180, node.w * this.scale)}px`;
      editor.style.height = `${Math.max(52, node.h * this.scale + 10)}px`;
      this.container.appendChild(editor);
      editor.focus(); editor.select();
      let done = false;
      const commit = (save) => {
        if (done) return; done = true;
        const value = editor.value.trim();
        editor.remove();
        if (save && value && value !== node.title) {
          node.title = value;
          this.render();
          this._changed();
        }
      };
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(true); }
        if (e.key === 'Escape') commit(false);
      });
      editor.addEventListener('blur', () => commit(true));
      editor.addEventListener('mousedown', (e) => e.stopPropagation());
    }
    addChild(title) {
      const parent = this.selected || this.tree;
      if (!parent) return;
      const child = clone({ title: title || 'Ý mới', children: [] }, parent.depth + 1);
      parent.children.push(child);
      parent.collapsed = false;
      this.selected = child;
      this.render();
      this._changed();
      this.edit(child);
    }
    deleteSelected() {
      if (!this.selected || this.selected === this.tree) return false;
      const parent = this._parentOf(this.selected);
      parent.children = parent.children.filter((c) => c !== this.selected);
      this.selected = null;
      this.render();
      this._changed();
      return true;
    }

    // ------------------------------------------------------------- xuất
    exportSVG() {
      const b = this._bounds();
      const pad = 24;
      const svg = this.svg.cloneNode(true);
      svg.setAttribute('xmlns', NS);
      svg.setAttribute('width', Math.ceil(b.w + pad * 2));
      svg.setAttribute('height', Math.ceil(b.h + pad * 2));
      svg.setAttribute('viewBox', `${b.x - pad} ${b.y - pad} ${b.w + pad * 2} ${b.h + pad * 2}`);
      svg.querySelector('g').removeAttribute('transform');
      svg.querySelectorAll('.selected rect').forEach((r) => { r.setAttribute('stroke-width', 1.5); });
      const bg = el('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, fill: '#ffffff' });
      svg.insertBefore(bg, svg.firstChild);
      return new XMLSerializer().serializeToString(svg);
    }
    exportPNG(scale) {
      const source = this.exportSVG();
      return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const factor = scale || 2;
          canvas.width = img.width * factor; canvas.height = img.height * factor;
          const ctx = canvas.getContext('2d');
          ctx.scale(factor, factor);
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Không tạo được PNG'))), 'image/png');
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Không dựng được ảnh từ SVG')); };
        img.src = url;
      });
    }
  }
  global.MindMap = MindMap;
})(window);
