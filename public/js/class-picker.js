/**
 * ClassPicker - shared interactive class/section picker.
 *
 * Preferred (CSP-safe, auto-initialising) usage — no inline JS needed:
 *   <div id="cpicker-x"
 *        data-cpicker
 *        data-cpicker-source="cpicker-x-classes"
 *        data-cpicker-field="classLevels"
 *        data-cpicker-required></div>
 *   ...
 *   <script type="application/json" id="cpicker-x-classes">[ ...classes... ]</script>
 *   <script src="/js/class-picker.js"></script>
 *
 * Every [data-cpicker] element is initialised on DOM ready by reading the JSON
 * island named in data-cpicker-source. This mirrors the app's Content-Security
 * -Policy convention (no 'unsafe-inline' script-src; data travels via
 * non-executed <script type="application/json"> islands).
 *
 * Programmatic usage is also supported:
 *   ClassPicker.init('container-id', classesArray, {
 *     fieldName: 'classLevels',
 *     required: true
 *   });
 *
 * Each class object needs: _id, name, gradeLevel, group?, section?
 */
(function () {
  'use strict';

  var GRADE_ORDER = ['PG','1','2','3','4','5','6','7','8','9','10','11','12'];
  var GRADE_NAMES = {
    'PG': 'PG',
    '1':  'Class One',   '2': 'Class Two',   '3': 'Class Three',
    '4':  'Class Four',  '5': 'Class Five',   '6': 'Class Six',
    '7':  'Class Seven', '8': 'Class Eight',
    '9':  '9th',  '10': '10th', '11': '11th', '12': '12th'
  };
  var MAX_SUMMARY_TAGS = 4;
  var CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ' +
    'stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

  function gradeLabel(g) { return GRADE_NAMES[g] || g; }
  function classLabel(c) { return c.name; }
  function classSearchText(c) {
    return [c.gradeLevel, gradeLabel(c.gradeLevel), c.name, c.group, c.section]
      .filter(Boolean).join(' ').toLowerCase();
  }

  function getSelectedIds(container) {
    var ids = [];
    container.querySelectorAll('.cpicker-item-cb:checked').forEach(function (cb) {
      ids.push(cb.value);
    });
    return ids;
  }

  function findClass(classes, id) {
    for (var i = 0; i < classes.length; i++) {
      if (classes[i]._id === id) return classes[i];
    }
    return null;
  }

  function syncGroupCb(group) {
    var cbs = group.querySelectorAll('.cpicker-item-cb');
    var gcb = group.querySelector('.cpicker-group-cb');
    if (!gcb || !cbs.length) return;
    var n = 0;
    cbs.forEach(function (cb) { if (cb.checked) n++; });
    gcb.checked = n === cbs.length;
    gcb.indeterminate = n > 0 && n < cbs.length;
  }

  function updateSummary(el, classes) {
    var bar = el.querySelector('.cpicker-summary');
    var ids = getSelectedIds(el);
    bar.innerHTML = '';
    if (ids.length === 0) {
      bar.textContent = 'No classes selected';
      return;
    }
    var countEl = document.createElement('span');
    countEl.className = 'cpicker-summary-count';
    countEl.textContent = ids.length + ' selected';
    bar.appendChild(countEl);

    var tagsWrap = document.createElement('div');
    tagsWrap.className = 'cpicker-summary-tags';
    var show = Math.min(ids.length, MAX_SUMMARY_TAGS);
    for (var i = 0; i < show; i++) {
      var c = findClass(classes, ids[i]);
      if (!c) continue;
      var tag = document.createElement('span');
      tag.className = 'cpicker-tag';
      tag.appendChild(document.createTextNode(classLabel(c) + ' '));
      var xBtn = document.createElement('button');
      xBtn.type = 'button';
      xBtn.className = 'cpicker-tag-x';
      xBtn.textContent = '\u00d7';
      xBtn.setAttribute('data-id', c._id);
      xBtn.addEventListener('click', function () {
        var rid = this.getAttribute('data-id');
        var cb = el.querySelector('.cpicker-item-cb[value="' + rid + '"]');
        if (cb) { cb.checked = false; handleChange(el, classes); }
      });
      tag.appendChild(xBtn);
      tagsWrap.appendChild(tag);
    }
    if (ids.length > MAX_SUMMARY_TAGS) {
      var more = document.createElement('span');
      more.className = 'cpicker-summary-more';
      more.textContent = '+' + (ids.length - MAX_SUMMARY_TAGS) + ' more';
      tagsWrap.appendChild(more);
    }
    bar.appendChild(tagsWrap);
  }

  function syncHidden(el, fieldName) {
    var wrap = el.querySelector('.cpicker-hidden');
    wrap.innerHTML = '';
    el.querySelectorAll('.cpicker-item-cb:checked').forEach(function (cb) {
      var inp = document.createElement('input');
      inp.type = 'hidden';
      inp.name = fieldName;
      inp.value = cb.value;
      wrap.appendChild(inp);
    });
  }

  function handleChange(el, classes) {
    el.querySelectorAll('.cpicker-group').forEach(syncGroupCb);
    updateSummary(el, classes);
    syncHidden(el, el._cpField);
  }

  function applyFilter(el, query) {
    var q = query.toLowerCase().trim();
    var visibleGroups = 0;
    el.querySelectorAll('.cpicker-group').forEach(function (group) {
      var items = group.querySelectorAll('.cpicker-item');
      var visibleItems = 0;
      items.forEach(function (item) {
        var text = item.getAttribute('data-search') || '';
        if (!q || text.indexOf(q) !== -1) {
          item.style.display = '';
          visibleItems++;
        } else {
          item.style.display = 'none';
        }
      });
      group.style.display = visibleItems > 0 ? '' : 'none';
      if (visibleItems > 0) visibleGroups++;
    });
    var noRes = el.querySelector('.cpicker-no-results');
    if (noRes) noRes.style.display = visibleGroups === 0 ? '' : 'none';
  }

  function buildGroup(key, groupClasses, el, classes) {
    var group = document.createElement('div');
    group.className = 'cpicker-group';
    group.setAttribute('data-grade', key);

    var header = document.createElement('div');
    header.className = 'cpicker-group-header';

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'cpicker-group-toggle';
    toggle.setAttribute('aria-label', 'Toggle ' + gradeLabel(key));
    toggle.innerHTML = CHEVRON_SVG;
    toggle.addEventListener('click', function () {
      group.classList.toggle('collapsed');
    });
    header.appendChild(toggle);

    var label = document.createElement('label');
    label.className = 'cpicker-group-label';
    var gcb = document.createElement('input');
    gcb.type = 'checkbox';
    gcb.className = 'cpicker-group-cb';
    gcb.addEventListener('change', function () {
      var checked = this.checked;
      group.querySelectorAll('.cpicker-item-cb').forEach(function (cb) {
        var row = cb.closest('.cpicker-item');
        if (row.style.display !== 'none') cb.checked = checked;
      });
      handleChange(el, classes);
    });
    label.appendChild(gcb);
    var nameSpan = document.createElement('span');
    nameSpan.textContent = gradeLabel(key);
    label.appendChild(nameSpan);
    var countSpan = document.createElement('span');
    countSpan.className = 'cpicker-group-count';
    countSpan.textContent = '(' + groupClasses.length + ')';
    label.appendChild(countSpan);
    header.appendChild(label);
    group.appendChild(header);

    var body = document.createElement('div');
    body.className = 'cpicker-group-body';
    groupClasses.forEach(function (c) {
      var item = document.createElement('label');
      item.className = 'cpicker-item';
      item.setAttribute('data-search', classSearchText(c));
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'cpicker-item-cb';
      cb.value = c._id;
      cb.addEventListener('change', function () {
        handleChange(el, classes);
      });
      item.appendChild(cb);
      var span = document.createElement('span');
      span.className = 'cpicker-item-name';
      span.textContent = classLabel(c);
      item.appendChild(span);
      body.appendChild(item);
    });
    group.appendChild(body);
    return group;
  }

  function init(containerId, classes, opts) {
    opts = opts || {};
    var fieldName = opts.fieldName || 'classLevels';
    var required  = !!opts.required;
    var el = document.getElementById(containerId);
    if (!el || !classes) return;

    el._cpField = fieldName;

    if (!classes.length) {
      el.className = 'cpicker';
      el.innerHTML = '<div class="cpicker-empty">No classes available</div>';
      return;
    }

    var groups = {};
    classes.forEach(function (c) {
      var gl = c.gradeLevel || 'PG';
      if (!groups[gl]) groups[gl] = [];
      groups[gl].push(c);
    });
    var sortedKeys = Object.keys(groups).sort(function (a, b) {
      return GRADE_ORDER.indexOf(a) - GRADE_ORDER.indexOf(b);
    });

    el.innerHTML = '';
    el.className = 'cpicker';

    var searchWrap = document.createElement('div');
    searchWrap.className = 'cpicker-search';
    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search classes\u2026';
    searchInput.className = 'cpicker-search-input';
    searchInput.addEventListener('input', function () {
      applyFilter(el, this.value);
    });
    searchWrap.appendChild(searchInput);
    el.appendChild(searchWrap);

    var summary = document.createElement('div');
    summary.className = 'cpicker-summary';
    summary.textContent = 'No classes selected';
    el.appendChild(summary);

    var list = document.createElement('div');
    list.className = 'cpicker-list';
    el.appendChild(list);

    var hiddenWrap = document.createElement('div');
    hiddenWrap.className = 'cpicker-hidden';
    el.appendChild(hiddenWrap);

    sortedKeys.forEach(function (key) {
      list.appendChild(buildGroup(key, groups[key], el, classes));
    });

    var noRes = document.createElement('div');
    noRes.className = 'cpicker-no-results';
    noRes.textContent = 'No matching classes';
    noRes.style.display = 'none';
    list.appendChild(noRes);

    if (required) {
      var form = el.closest('form');
      if (form) {
        form.addEventListener('submit', function (e) {
          if (getSelectedIds(el).length === 0) {
            e.preventDefault();
            summary.style.background = 'rgba(220,38,38,0.06)';
            summary.style.color = '#dc2626';
            summary.textContent = 'Please select at least one class';
            setTimeout(function () {
              summary.style.background = '';
              summary.style.color = '';
              updateSummary(el, classes);
            }, 2500);
          }
        });
      }
    }

    updateSummary(el, classes);
    syncHidden(el, fieldName);
  }

  function autoInit() {
    var nodes = document.querySelectorAll('[data-cpicker]');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node.id || node._cpInited) continue;
      node._cpInited = true;
      var classes = [];
      var srcId = node.getAttribute('data-cpicker-source');
      if (srcId) {
        var island = document.getElementById(srcId);
        if (island) {
          try { classes = JSON.parse(island.textContent || '[]'); }
          catch (e) { classes = []; }
        }
      }
      init(node.id, classes, {
        fieldName: node.getAttribute('data-cpicker-field') || 'classLevels',
        required: node.hasAttribute('data-cpicker-required')
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }

  window.ClassPicker = { init: init };
})();
