/**
 * Tests for the redesigned Students register table (Admin / Manager, /students).
 *
 * The change is presentation-only, so the tests are too: the REAL template is
 * rendered and the resulting HTML is asserted, rather than pattern-matching the
 * EJS source. Covers
 *   • a circular avatar per row from Student.photoUrl, with an initials
 *     fallback when a pupil has no photo,
 *   • a leading checkbox column (per row + a page-scoped select-all),
 *   • icon-only actions with no visible text labels,
 *   • the search box: magnifier + the "Search by name or roll." placeholder,
 *   • every pre-existing column and link still present — nothing was dropped,
 *   • the delete icon wired to the route that already existed (POST + CSRF +
 *     confirm gate), with no new route or data path,
 *   • CSP safety (no inline handlers/scripts) and escaping of hostile names,
 *   • the stylesheet rules the markup depends on,
 *   • the select-all behaviour of public/js/students-row-select.js.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const ROOT = path.join(__dirname, "..");
const VIEW = path.join(ROOT, "views", "students", "list.ejs");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const { safeJson } = require("../utils/safeJson");

// ── fixtures ─────────────────────────────────────────────────────────────────
const WITH_PHOTO = {
  _id: "s1",
  name: "Ali Khan",
  rollNumber: "7",
  fatherName: "Imran Khan",
  familyNumber: "FAM-1001",
  gender: "Male",
  classLevel: { _id: "c1", name: "Grade 9-Boys" },
  dateAdmitted: new Date("2024-04-01T00:00:00.000Z"),
  status: "active",
  photoUrl: "/uploads/photos/ali.jpg",
};

const NO_PHOTO = {
  _id: "s2",
  name: "Sara",
  rollNumber: "12",
  fatherName: "Nadeem Malik",
  familyNumber: null,
  gender: "Female",
  classLevel: { _id: "c2", name: "Grade 9-Girls" },
  dateAdmitted: new Date("2025-09-01T00:00:00.000Z"),
  status: "inactive",
  photoUrl: null,
};

const HOSTILE = {
  ...NO_PHOTO,
  _id: "s3",
  name: '<img src=x onerror="alert(1)">',
  photoUrl: '" onload="alert(2)',
};

function renderList(students) {
  return ejs.render(read("views/students/list.ejs"), {
    page: "students",
    user: { role: "admin", name: "Ada" },
    schoolName: "Test School",
    csrfToken: "csrf-test",
    ok: false,
    createError: null,
    loadError: null,
    students,
    pagination: null,
    classes: [{ _id: "c1", name: "Grade 9-Boys", gradeLevel: 9, sectionRef: { name: "Boys" } }],
    studentPool: [],
    filters: { class: "", grade: "", section: "", status: "", name: "", parent: "", sortBy: "" },
    filterOptions: { grades: ["9"], sections: ["Boys"], statuses: [{ value: "enrolled", label: "Enrolled" }] },
    totalStudents: students.length,
    admissionDefault: "2026-11-23",
    safeJson,
  }, { filename: VIEW });
}

// The markup of one rendered row, keyed by the pupil's id.
const rowOf = (html, id) =>
  html.match(new RegExp(`<tr class="roster-row" data-student-id="${id}">[\\s\\S]*?</tr>`))[0];

describe("roster table — avatar", () => {
  const html = () => renderList([WITH_PHOTO, NO_PHOTO]);

  it("shows the stored photo in a circular avatar when one exists", () => {
    const row = rowOf(html(), "s1");
    expect(row).toContain('<span class="st-avatar has-photo">');
    expect(row).toMatch(/<img src="\/uploads\/photos\/ali\.jpg" alt="" loading="lazy"/);
    // an avatar with a real photo must not also print initials
    expect(row).not.toContain("st-avatar-initials");
  });

  it("falls back to an initials avatar when there is no photo", () => {
    const row = rowOf(html(), "s2");
    expect(row).toContain('<span class="st-avatar">');
    expect(row).toContain('<span class="st-avatar-initials" aria-hidden="true">S</span>');
    expect(row).not.toContain("<img");
  });

  it("derives two initials from a two-part name", () => {
    expect(rowOf(html(), "s1")).not.toContain("st-avatar-initials"); // has a photo
    const only = rowOf(renderList([{ ...WITH_PHOTO, photoUrl: "" }]), "s1");
    expect(only).toContain('<span class="st-avatar-initials" aria-hidden="true">AK</span>');
  });

  it("the avatar sits beside the name inside the Name cell", () => {
    const row = rowOf(html(), "s1");
    const nameCell = row.match(/<td data-label="Name"[\s\S]*?<\/td>/)[0];
    expect(nameCell.indexOf("st-avatar")).toBeLessThan(nameCell.indexOf("Ali Khan"));
    expect(nameCell).toContain('<strong class="st-name">Ali Khan</strong>');
  });
});

describe("roster table — selection column", () => {
  const html = () => renderList([WITH_PHOTO, NO_PHOTO]);

  it("puts a select-all checkbox in the header, left of every data column", () => {
    const head = html().match(/<thead>[\s\S]*?<\/thead>/)[0];
    expect(head).toContain('id="st-select-all"');
    expect(head.indexOf('id="st-select-all"')).toBeLessThan(head.indexOf("Roll #"));
  });

  it("gives every row a leading checkbox carrying the Student id", () => {
    expect(rowOf(html(), "s1")).toContain('<input type="checkbox" class="row-check st-row-check" value="s1"');
    expect(rowOf(html(), "s2")).toContain('<input type="checkbox" class="row-check st-row-check" value="s2"');
  });

  it("labels each checkbox for assistive tech", () => {
    expect(rowOf(html(), "s1")).toContain('aria-label="Select Ali Khan"');
  });

  it("the first cell of a row is the checkbox, not the roll number", () => {
    const firstTd = rowOf(html(), "s1").match(/<td[^>]*>[\s\S]*?<\/td>/)[0];
    expect(firstTd).toContain("col-select");
    expect(firstTd).toContain('type="checkbox"');
  });
});

describe("roster table — icon-only actions", () => {
  const html = () => renderList([WITH_PHOTO]);
  const actionsOf = () => rowOf(html(), "s1").match(/<td data-label="Actions"[\s\S]*?<\/td>/)[0];

  it("keeps every existing destination as an icon button", () => {
    const actions = actionsOf();
    ["/students/s1/edit", "/students/s1/analysis", "/students/s1/photo"].forEach((href) => {
      expect(actions).toContain(`href="${href}"`);
    });
  });

  it("renders no visible button labels — only SVG inside the controls", () => {
    const actions = actionsOf();
    ["Edit", "View", "Photo", "Delete"].forEach((word) => {
      // the word may appear in a title/aria-label, never as element text
      expect(actions).not.toMatch(new RegExp(`>[^<]*\\b${word}\\b[^<]*<svg`));
      expect(actions).not.toMatch(new RegExp(`</a>\\s*${word}`));
    });
    const textNodes = actions.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();
    expect(textNodes).toBe("");
    expect((actions.match(/<svg/g) || []).length).toBe(4); // view, edit, photo, delete
  });

  it("carries meaning in title + aria-label instead of text", () => {
    const actions = actionsOf();
    expect(actions).toContain('title="Edit"');
    expect(actions).toContain('aria-label="Edit Ali Khan"');
    expect(actions).toContain('class="icon-btn icon-btn-danger"');
  });

  it("each icon is inline SVG (no icon font, no image request)", () => {
    const actions = actionsOf();
    expect(actions).toContain('viewBox="0 0 24 24"');
    expect(actions).toContain("stroke=\"currentColor\"");
    expect(actions).not.toContain("<i class=");
    expect(actions).not.toContain("<img");
  });
});

describe("roster table — delete keeps the existing guarded route", () => {
  const actions = () =>
    rowOf(renderList([WITH_PHOTO]), "s1").match(/<td data-label="Actions"[\s\S]*?<\/td>/)[0];

  it("posts to the route that already existed, with a CSRF token", () => {
    expect(actions()).toContain('<form method="POST" action="/students/s1/delete"');
    expect(actions()).toContain('<input type="hidden" name="_csrf" value="csrf-test" />');
  });

  it("is gated by the shared data-confirm dialog and warns the delete is final", () => {
    const confirm = actions().match(/data-confirm="([^"]*)"/)[1];
    expect(confirm).toContain("Ali Khan");
    expect(confirm).toContain("cannot be undone");
    // hard cascade: attendance + test records go with the pupil
    expect(confirm.toLowerCase()).toContain("attendance");
  });

  it("is not a GET link — a delete must never be a crawlable href", () => {
    expect(actions()).not.toMatch(/<a[^>]+href="[^"]*\/delete"/);
  });

  it("no route, controller or service was needed for it", () => {
    const src = read("routes/views/students.views.js");
    expect(src).toContain('router.post("/students/:studentId/delete", requireAdminOrManager()');
    // the list query still returns the whole document bar the password hash,
    // which is what makes photoUrl available to the avatar
    expect(src).toContain('select: "-password"');
  });
});

describe("filter bar — search input", () => {
  const html = () => renderList([WITH_PHOTO]);
  const searchBox = () => html().match(/<div class="st-search-box">[\s\S]*?<\/div>\s*<\/div>/)[0];

  it("shows a magnifier and the requested placeholder", () => {
    expect(searchBox()).toContain('<span class="st-search-icon" aria-hidden="true">');
    expect(searchBox()).toContain("<circle cx=\"11\" cy=\"11\" r=\"8\"");
    expect(searchBox()).toContain('placeholder="Search by name or roll."');
  });

  it("keeps the shared typeahead contract intact (same ids, same submit control)", () => {
    const src = html();
    expect(src).toContain('id="st-student-search"');
    expect(src).toContain('name="name" id="st-student-name"');
    expect(src).toContain('id="st-student-results"');
    expect(src).toContain('id="st-filter-form"');
  });
});

describe("redesign is presentation-only", () => {
  const html = () => renderList([WITH_PHOTO, NO_PHOTO]);

  it("keeps every pre-existing column, header for header", () => {
    const head = html().match(/<thead>[\s\S]*?<\/thead>/)[0];
    ["Roll #", "Name", "Father's name", "Family", "Gender", "Class", "Admitted", "Status"]
      .forEach((label) => expect(head).toContain(label));
  });

  it("keeps every pre-existing cell value and its data-label", () => {
    const row = rowOf(html(), "s1");
    expect(row).toContain('data-label="Roll #"');
    expect(row).toContain(">7<");            // roll
    expect(row).toContain("Imran Khan");     // father
    expect(row).toContain("FAM-1001");       // family pill
    expect(row).toContain(">Male<");         // gender
    expect(row).toContain("Grade 9-Boys");   // class
    expect(row).toContain('data-label="Admitted"');
    expect(row).toContain('<span class="pill ocr">Active</span>');
  });

  it("keeps the status pills working for an inactive pupil", () => {
    expect(rowOf(html(), "s2")).toContain('<span class="pill error">Inactive</span>');
  });

  it("keeps the register form, the cascade filter ids and the script order", () => {
    const src = html();
    expect(src).toContain('<form method="POST" action="/students/create">');
    ["st-filter-grade", "st-filter-section", "st-filter-class", "st-filter-status"].forEach((id) => {
      expect(src).toContain(`id="${id}"`);
    });
    const typeahead = src.indexOf('<script src="/js/student-typeahead.js"></script>');
    const cascade = src.indexOf('<script src="/js/students-filter-cascade.js"></script>');
    const wiring = src.indexOf('<script src="/js/students-typeahead.js"></script>');
    const select = src.indexOf('<script src="/js/students-row-select.js"></script>');
    expect(typeahead).toBeGreaterThan(-1);
    expect(cascade).toBeGreaterThan(typeahead);
    expect(wiring).toBeGreaterThan(cascade);
    expect(select).toBeGreaterThan(wiring);
  });
});

describe("markup safety under the app's CSP + escaping", () => {
  it("a hostile name/photourl is escaped, never rendered live", () => {
    const row = rowOf(renderList([HOSTILE]), "s3");
    // Structural, not textual: the payload's WORDS still appear as inert,
    // entity-escaped data. What must not exist is live markup or a second
    // attribute forged out of the value.
    expect(row).not.toContain("<img src=x");
    expect(row).not.toContain('onerror="');
    expect(row).not.toContain(' onload="');
    expect(row).toContain("&lt;img src=x");
    expect(row).toContain("onerror=&#34;");
    // one real <img> — the avatar built from the (escaped) photoUrl
    expect((row.match(/<img/g) || []).length).toBe(1);
  });

  it("no inline event handler or inline executable script was added", () => {
    const src = read("views/students/list.ejs");
    expect(src).not.toMatch(/\son(click|submit|change|input|load|error)=/i);
    expect(src).not.toMatch(/<script(?![^>]*application\/json)[^>]*>(?!\s*<\/script>)[\s\S]*?<\/script>/);
  });
});

describe("stylesheet", () => {
  const css = read("public/css/style.css");
  const rule = (sel) => {
    const at = css.indexOf(sel);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at) + 1);
  };

  it("defines the avatar as a circle that crops the photo", () => {
    const r = rule(".st-avatar {");
    expect(r).toContain("border-radius: 50%");
    expect(r).toContain("overflow: hidden");
    expect(rule(".st-avatar img")).toContain("object-fit: cover");
  });

  it("styles the icon buttons without a border or background plate", () => {
    const r = rule(".icon-btn {");
    expect(r).toContain("background: transparent");
    expect(r).toContain("border: none");
    expect(r).toContain("display: inline-flex");
    expect(rule(".icon-btn-danger:hover")).toContain("var(--error)");
  });

  it("keeps row dividers hairline and the hover subtle", () => {
    expect(rule(".roster-table td, .roster-table th")).toContain("padding: 13px 20px");
    expect(rule(".roster-table tbody tr:hover td")).toContain("rgba(244, 246, 251");
    // the last row must not leave a dangling divider under the panel edge
    expect(rule(".roster-table tbody tr:last-child td")).toContain("border-bottom: none");
  });

  it("resets the global form styling that would bloat the checkboxes", () => {
    const r = rule(".row-check {");
    expect(r).toContain("padding: 0");
    expect(r).toContain("border: none");
  });

  it("indents the search text so it cannot run under the magnifier", () => {
    expect(rule(".st-search-input")).toContain("padding-left: 33px");
    expect(rule(".st-search-icon")).toContain("pointer-events: none");
  });

  it("drops back to the shared compact card padding on phones", () => {
    // .roster-table td (0,1,1) is declared after .card-table td (0,1,1), so
    // without this tie-break the roster rows would swell out of card mode.
    const mobile = css.slice(css.indexOf("@media (max-width: 480px) {", css.indexOf(".st-search-box")));
    expect(rule(".card-table.roster-table td")).toContain("padding: 7px 14px");
    expect(mobile.indexOf(".card-table.roster-table td")).toBeGreaterThan(-1);
  });
});

// ── row-selection behaviour ──────────────────────────────────────────────────
describe("public/js/students-row-select.js", () => {
  function makeEl(tag) {
    const el = {
      tagName: tag,
      className: "",
      children: [],
      checked: false,
      indeterminate: false,
      disabled: false,
      _listeners: {},
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      fire(ev) { (this._listeners[ev] || []).forEach((fn) => fn({})); },
      querySelectorAll(sel) {
        const cls = sel.slice(1);
        return this.children.filter((c) => (c.className || "").split(" ").indexOf(cls) !== -1);
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    };
    return el;
  }

  function harness(rowCount) {
    const table = makeEl("table");
    table.className = "ledger card-table roster-table";
    const boxes = [];
    for (let i = 0; i < rowCount; i++) {
      const b = makeEl("input");
      b.className = "row-check st-row-check";
      table.children.push(b);
      boxes.push(b);
    }
    const header = makeEl("input");
    const sandbox = {
      document: {
        querySelector: (sel) => (sel === ".roster-table" ? table : null),
        getElementById: (id) => (id === "st-select-all" ? header : null),
      },
      String, Array, Object, RegExp,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read("public/js/students-row-select.js"), sandbox, { filename: "students-row-select.js" });
    return { table, header, boxes };
  }

  it("select-all ticks every row on the page", () => {
    const h = harness(3);
    h.header.checked = true;
    h.header.fire("change");
    expect(h.boxes.every((b) => b.checked)).toBe(true);
  });

  it("un-ticking select-all clears the rows", () => {
    const h = harness(3);
    h.header.checked = true; h.header.fire("change");
    h.header.checked = false; h.header.fire("change");
    expect(h.boxes.some((b) => b.checked)).toBe(false);
  });

  it("ticking every row by hand checks the header", () => {
    const h = harness(2);
    h.boxes.forEach((b) => { b.checked = true; b.fire("change"); });
    expect(h.header.checked).toBe(true);
    expect(h.header.indeterminate).toBe(false);
  });

  it("a partial selection leaves the header indeterminate, not checked", () => {
    const h = harness(3);
    h.boxes[0].checked = true;
    h.boxes[0].fire("change");
    expect(h.header.indeterminate).toBe(true);
    expect(h.header.checked).toBe(false);
  });

  it("starting from zero rows leaves the header unticked", () => {
    const h = harness(1);
    h.boxes[0].checked = true; h.boxes[0].fire("change");
    h.boxes[0].checked = false; h.boxes[0].fire("change");
    expect(h.header.checked).toBe(false);
    expect(h.header.indeterminate).toBe(false);
  });

  it("disables select-all when the filter matched no pupil", () => {
    const h = harness(0);
    expect(h.header.disabled).toBe(true);
  });

  it("never submits a form — bulk actions do not exist yet", () => {
    const src = read("public/js/students-row-select.js");
    expect(src).not.toMatch(/\.submit\(/);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/<form/);
  });
});
