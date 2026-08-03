/* layers/layers.js — 9 map modes with single-active-mode rule.
   Per spec scenario "单一主模式": switching to a mode highlights only that
   dimension to avoid information overload. Clicking a mode calls CM.setMode(),
   which deactivates any previous mode and re-renders the map. */
(function () {
  'use strict';
  var CM = window.CM;

  CM.layers = {
    render: function () {
      var box = document.getElementById('mode-list');
      var active = CM.state.activeMode;
      box.innerHTML = CM.MODES.map(function (m) {
        var on = m.id === active;
        return '<button class="cm-mode-btn' + (on ? ' active' : '') + '" data-mode="' + m.id + '">' +
          '<span class="cm-mode-swatch" style="background:' + m.color + '"></span>' +
          '<span class="cm-mode-name">' + m.name + '</span>' +
          '<span class="cm-mode-desc">' + m.desc + '</span>' +
          '</button>';
      }).join('');
      // wire clicks — each click replaces the active mode (single-active rule).
      box.querySelectorAll('.cm-mode-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          if (CM.state.activeMode !== b.dataset.mode) CM.setMode(b.dataset.mode);
        });
      });
      // mode banner reflects the active dimension.
      var meta = CM.modeMeta(active);
      var banner = document.getElementById('mode-banner');
      banner.textContent = meta.name + '模式';
      banner.style.background = meta.color;
      var meta2 = document.getElementById('map-meta');
      var levelLabel = CM.state.mapLevel === 'L1' ? 'L1 2.5D 地图' : 'L0 二维地图';
      var dsTag = CM.state.dataSource === 'backend' ? 'LIVE 后端' : '离线样本';
      meta2.textContent = '来源 ' + dsTag + ' · 坐标系 工厂局部（米）· 维度：' + meta.name + ' · ' + levelLabel;
    }
  };
})();
