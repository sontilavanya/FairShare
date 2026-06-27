'use strict';
/**
 * FairShare – app.js
 * ─────────────────────────────────────────────────────────
 * DB       : localStorage persistence
 * Store    : single source of truth for all data
 * Calc     : all balance calculations (no mistakes)
 * Nav      : page routing + back stack
 * Render   : all DOM rendering
 * Modals   : modal open/close + form population
 * Actions  : save friend, bill, group, settle, etc.
 */

/* ══════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════ */
const fmt   = n => '₹' + Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const r2    = n => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const uid   = () => '_' + Math.random().toString(36).slice(2, 10);
const fmtDate = s => {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

const AVATAR_COLOURS = [
  '#7c3aed','#2563eb','#059669','#dc2626',
  '#d97706','#db2777','#0891b2','#65a30d',
];
let _colourIdx = 0;
const nextColour = () => AVATAR_COLOURS[_colourIdx++ % AVATAR_COLOURS.length];

const ICONS = { trip:'✈️', home:'🏠', food:'🍔', work:'💼', other:'👥' };

const toast = (msg, dur = 2500) => {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), dur);
};

/* ══════════════════════════════════════════════════════
   DB – localStorage
══════════════════════════════════════════════════════ */
const DB = {
  KEY: 'fairshare_v2',
  load() {
    try { const r = localStorage.getItem(this.KEY); return r ? JSON.parse(r) : null; }
    catch { return null; }
  },
  save(d) {
    try { localStorage.setItem(this.KEY, JSON.stringify(d)); } catch {}
  },
  default() {
    return { friends: [], bills: [], groups: [], history: [] };
  },
};

/* ══════════════════════════════════════════════════════
   STORE – single source of truth
══════════════════════════════════════════════════════ */
const Store = {
  friends: [],  // { id, name, contact, colour }
  bills: [],    // { id, name, amount, date, note, splits:[{friendId,amount,settled}] }
  groups: [],   // { id, name, type, members:[friendId], expenses:[{id,name,amount,date,note,splits:[{friendId,amount,settled}]}] }
  history: [],  // settled items { id, type, name, amount, settledAt, detail }

  init() {
    const d = DB.load() || DB.default();
    this.friends = d.friends || [];
    this.bills   = d.bills   || [];
    this.groups  = d.groups  || [];
    this.history = d.history || [];
    this._pruneHistory();
  },

  save() {
    DB.save({ friends: this.friends, bills: this.bills, groups: this.groups, history: this.history });
  },

  getFriend(id)   { return this.friends.find(f => f.id === id); },
  getBill(id)     { return this.bills.find(b => b.id === id); },
  getGroup(id)    { return this.groups.find(g => g.id === id); },

  /** Find friend by contact (phone/email) — prevents duplicates */
  findByContact(contact) {
    const c = contact.trim().toLowerCase();
    return this.friends.find(f => f.contact.trim().toLowerCase() === c);
  },

  /** Add or return existing friend. Returns friend object. */
  upsertFriend(name, contact) {
    const existing = this.findByContact(contact);
    if (existing) return existing;
    const f = { id: uid(), name: name.trim(), contact: contact.trim(), colour: nextColour() };
    this.friends.push(f);
    this.save();
    return f;
  },

  /** Prune history older than 30 days */
  _pruneHistory() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    this.history = this.history.filter(h => new Date(h.settledAt).getTime() > cutoff);
    this.save();
  },
};

/* ══════════════════════════════════════════════════════
   CALC – all balance calculations
   Rule: "You" always paid. Friends owe "You".
   Positive balance = friend owes you.
   Negative balance = you owe friend (not implemented in phase 1,
   but structure supports it).
══════════════════════════════════════════════════════ */
const Calc = {
  /**
   * Returns { friendId → netAmount } across ALL bills + ALL group expenses.
   * Positive = they owe you. Negative = you owe them.
   * Only counts unsettled splits.
   */
  allBalances() {
    const bal = {};
    Store.friends.forEach(f => { bal[f.id] = 0; });

    // Individual bills
    for (const bill of Store.bills) {
      for (const sp of bill.splits) {
        if (!sp.settled) {
          bal[sp.friendId] = (bal[sp.friendId] || 0) + sp.amount;
        }
      }
    }

    // Group expenses
    for (const group of Store.groups) {
      for (const exp of group.expenses) {
        for (const sp of exp.splits) {
          if (!sp.settled) {
            bal[sp.friendId] = (bal[sp.friendId] || 0) + sp.amount;
          }
        }
      }
    }

    return bal;
  },

  /** Balance for one specific friend across everything */
  friendBalance(friendId) {
    return this.allBalances()[friendId] || 0;
  },

  /** All unsettled transactions involving a specific friend
   *  Returns array of { type:'bill'|'group', sourceId, expId?, name, date, amount, splitId, settled }
   */
  friendTransactions(friendId) {
    const txns = [];

    // Individual bills
    for (const bill of Store.bills) {
      const sp = bill.splits.find(s => s.friendId === friendId);
      if (sp) {
        txns.push({
          type: 'bill', sourceId: bill.id, expId: null,
          name: bill.name, date: bill.date,
          amount: sp.amount, settled: sp.settled,
          note: bill.note,
        });
      }
    }

    // Group expenses
    for (const group of Store.groups) {
      for (const exp of group.expenses) {
        const sp = exp.splits.find(s => s.friendId === friendId);
        if (sp) {
          txns.push({
            type: 'group', sourceId: group.id, expId: exp.id,
            name: `${exp.name} (${group.name})`,
            date: exp.date, amount: sp.amount, settled: sp.settled,
            note: exp.note,
          });
        }
      }
    }

    // Sort newest first
    txns.sort((a, b) => new Date(b.date) - new Date(a.date));
    return txns;
  },

  /** Balances within a group — who owes how much to "You" */
  groupBalances(groupId) {
    const group = Store.getGroup(groupId);
    if (!group) return [];
    const bal = {};
    group.members.forEach(id => { bal[id] = 0; });
    for (const exp of group.expenses) {
      for (const sp of exp.splits) {
        if (!sp.settled) bal[sp.friendId] = (bal[sp.friendId] || 0) + sp.amount;
      }
    }
    return Object.entries(bal).map(([id, amt]) => ({ friendId: id, amount: amt })).filter(b => b.amount > 0.005);
  },

  summaryTotals() {
    const bals = this.allBalances();
    let owed = 0, owe = 0;
    for (const a of Object.values(bals)) {
      if (a > 0) owed += a; else owe += Math.abs(a);
    }
    return { owed: r2(owed), owe: r2(owe), net: r2(owed - owe) };
  },
};

/* ══════════════════════════════════════════════════════
   NAV – page routing
══════════════════════════════════════════════════════ */
const Nav = {
  stack: [],
  current: 'pageHome',
  _detail: {},  // extra context for detail pages

  go(pageId, btn) {
    // hide all pages
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId).classList.add('active');

    // nav highlight (only for main tabs)
    document.querySelectorAll('.nav-btn[data-page]').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    // topbar
    const titles = {
      pageHome: 'FairShare', pageBills: 'Bills',
      pageGroups: 'Groups', pageHistory: 'History',
    };
    document.getElementById('topbarTitle').textContent = titles[pageId] || '';
    document.getElementById('backBtn').classList.toggle('hidden',
      ['pageHome','pageBills','pageGroups','pageHistory'].includes(pageId));
    document.getElementById('topbarRight').innerHTML = '';

    if (pageId !== this.current) this.stack.push(this.current);
    this.current = pageId;
    Render.page(pageId);
  },

  detail(pageId, context) {
    this._detail[pageId] = context;
    this.go(pageId, null);
  },

  back() {
    const prev = this.stack.pop();
    if (prev) this.go(prev, document.querySelector(`.nav-btn[data-page="${prev}"]`));
  },
};

/* ══════════════════════════════════════════════════════
   RENDER
══════════════════════════════════════════════════════ */
const Render = {
  page(id) {
    switch (id) {
      case 'pageHome':        return this.home();
      case 'pageFriendDetail':return this.friendDetail(Nav._detail['pageFriendDetail']);
      case 'pageBills':       return this.bills();
      case 'pageBillDetail':  return this.billDetail(Nav._detail['pageBillDetail']);
      case 'pageGroups':      return this.groups();
      case 'pageGroupDetail': return this.groupDetail(Nav._detail['pageGroupDetail']);
      case 'pageHistory':     return this.history();
    }
  },

  /* ── Home ──────────────────────────────────────────── */
  home() {
    const { owed, owe, net } = Calc.summaryTotals();
    document.getElementById('totalOwed').textContent  = fmt(owed);
    document.getElementById('totalOwe').textContent   = fmt(owe);
    const netEl = document.getElementById('netBalance');
    netEl.textContent = fmt(net);
    netEl.className = 'summary-val ' + (net > 0 ? 'green' : net < 0 ? 'red' : '');

    const bals = Calc.allBalances();
    const list = document.getElementById('friendsList');

    if (!Store.friends.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">👋</div><p>Add friends to start splitting bills</p></div>`;
      return;
    }

    list.innerHTML = Store.friends.map(f => {
      const bal = bals[f.id] || 0;
      const cls = bal > 0.005 ? 'positive' : bal < -0.005 ? 'negative' : 'zero';
      const lbl = bal > 0.005 ? 'owes you' : bal < -0.005 ? 'you owe' : 'settled up';
      return `
        <div class="friend-card" onclick="Nav.detail('pageFriendDetail','${f.id}')">
          <div class="avatar" style="background:${f.colour}">${initials(f.name)}</div>
          <div class="fc-info">
            <div class="fc-name">${esc(f.name)}</div>
            <div class="fc-contact">${esc(f.contact)}</div>
          </div>
          <div class="fc-balance">
            <div class="fc-bal-amt ${cls}">${fmt(Math.abs(bal))}</div>
            <div class="fc-bal-lbl">${lbl}</div>
          </div>
        </div>`;
    }).join('');
  },

  /* ── Friend Detail ─────────────────────────────────── */
  friendDetail(friendId) {
    const f = Store.getFriend(friendId);
    if (!f) return;
    const bal = Calc.friendBalance(friendId);
    const cls = bal > 0.005 ? 'positive' : bal < -0.005 ? 'negative' : 'zero';
    const lbl = bal > 0.005 ? 'owes you' : bal < -0.005 ? 'you owe' : 'All settled!';

    document.getElementById('friendDetailHeader').innerHTML = `
      <div class="avatar" style="background:${f.colour};width:54px;height:54px;font-size:1.2rem">${initials(f.name)}</div>
      <div class="fd-info">
        <div class="fd-name">${esc(f.name)}</div>
        <div class="fd-contact">${esc(f.contact)}</div>
        <div style="font-size:.75rem;color:var(--text2);margin-top:4px">${lbl}</div>
      </div>
      <div class="fd-balance ${cls}">${fmt(Math.abs(bal))}</div>
    `;

    document.getElementById('topbarTitle').textContent = f.name;

    const txns = Calc.friendTransactions(friendId);
    const container = document.getElementById('friendTransactions');

    if (!txns.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>No transactions yet</p></div>`;
    } else {
      container.innerHTML = txns.map(t => {
        const badge = t.type === 'bill'
          ? `<span class="txn-badge badge-bill">Bill</span>`
          : `<span class="txn-badge badge-group">Group</span>`;
        const amtCls = t.settled ? 'zero' : 'negative';
        const settleBtn = t.settled
          ? `<span class="btn-settle-done">✓ Settled</span>`
          : `<button class="btn-settle" onclick="Actions.settleTransaction('${f.id}','${t.sourceId}','${t.expId}','${t.type}')">Settle ₹${Math.abs(t.amount).toFixed(2)}</button>`;
        return `
          <div class="txn-card">
            <div class="txn-top">
              <div>
                <div class="txn-name">${esc(t.name)}</div>
                <div class="txn-meta">${fmtDate(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</div>
              </div>
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px">
                ${badge}
                <div class="txn-amount ${amtCls}">${fmt(t.amount)}</div>
              </div>
            </div>
            <div class="txn-bottom">${settleBtn}</div>
          </div>`;
      }).join('');
    }

    // Settle all button
    const unsettled = txns.filter(t => !t.settled);
    const totalUnsettled = r2(unsettled.reduce((s, t) => s + t.amount, 0));
    const settleAllDiv = document.getElementById('friendSettleAll');
    if (unsettled.length > 1) {
      settleAllDiv.innerHTML = `
        <button class="btn-full-green" onclick="Actions.settleAllWithFriend('${friendId}')">
          ✓ Settle All with ${esc(f.name)} — ${fmt(totalUnsettled)}
        </button>`;
    } else {
      settleAllDiv.innerHTML = '';
    }
  },

  /* ── Bills ─────────────────────────────────────────── */
  bills() {
    const list = document.getElementById('billsList');
    if (!Store.bills.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">🧾</div><p>No bills yet. Add your first bill!</p></div>`;
      return;
    }
    // newest first
    const sorted = [...Store.bills].sort((a, b) => new Date(b.date) - new Date(a.date));
    list.innerHTML = sorted.map(b => {
      const chips = b.splits.map(sp => {
        const f = Store.getFriend(sp.friendId);
        const cls = sp.settled ? 'settled' : 'unsettled';
        return `<span class="bill-person-chip ${cls}">${esc(f?.name || '?')}</span>`;
      }).join('');
      const allSettled = b.splits.every(s => s.settled);
      return `
        <div class="bill-card" onclick="Nav.detail('pageBillDetail','${b.id}')">
          <div class="bill-top">
            <div>
              <div class="bill-name">${esc(b.name)}</div>
              <div class="bill-meta">${fmtDate(b.date)}${b.note ? ' · ' + esc(b.note) : ''}</div>
            </div>
            <div>
              <div class="bill-amount">${fmt(b.amount)}</div>
              ${allSettled ? '<div style="font-size:.7rem;color:var(--green);text-align:right;margin-top:3px">✓ Settled</div>' : ''}
            </div>
          </div>
          <div class="bill-people">${chips}</div>
        </div>`;
    }).join('');
  },

  /* ── Bill Detail ───────────────────────────────────── */
  billDetail(billId) {
    const bill = Store.getBill(billId);
    if (!bill) return;
    document.getElementById('topbarTitle').textContent = bill.name;
    document.getElementById('billDetailHeader').innerHTML = `
      <div class="bd-name">${esc(bill.name)}</div>
      <div class="bd-meta">${fmtDate(bill.date)}${bill.note ? ' · ' + esc(bill.note) : ''}</div>
      <div class="bd-total">${fmt(bill.amount)}</div>
    `;
    document.getElementById('billSplits').innerHTML = bill.splits.map(sp => {
      const f = Store.getFriend(sp.friendId);
      const cls = sp.settled ? 'settled' : 'unsettled';
      const statusTxt = sp.settled ? '✓ Settled' : 'Unsettled';
      const btn = sp.settled
        ? `<span class="btn-settle-done" style="font-size:.8rem">✓ Done</span>`
        : `<button class="btn-settle" onclick="Actions.settleBillSplit('${billId}','${sp.friendId}')">Settle</button>`;
      return `
        <div class="split-person-card">
          <div class="avatar" style="background:${f?.colour||'#7c3aed'};width:40px;height:40px;font-size:.88rem">${initials(f?.name||'?')}</div>
          <div class="spc-info">
            <div class="spc-name">${esc(f?.name||'?')}</div>
            <div class="spc-status ${cls}">${statusTxt}</div>
          </div>
          <div class="spc-amount ${cls}">${fmt(sp.amount)}</div>
          ${btn}
        </div>`;
    }).join('');
  },

  /* ── Groups ────────────────────────────────────────── */
  groups() {
    const list = document.getElementById('groupsList');
    if (!Store.groups.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">👥</div><p>No groups yet. Create one!</p></div>`;
      return;
    }
    list.innerHTML = Store.groups.map(g => {
      const icon = ICONS[g.type] || '👥';
      const total = g.expenses.reduce((s, e) => s + e.amount, 0);
      const bals = Calc.groupBalances(g.id);
      const totalOwed = r2(bals.reduce((s, b) => s + b.amount, 0));
      const allSettled = bals.length === 0;
      return `
        <div class="group-card" onclick="Nav.detail('pageGroupDetail','${g.id}')">
          <div class="gc-top">
            <span class="gc-icon">${icon}</span>
            <div>
              <div class="gc-name">${esc(g.name)}</div>
              <div class="gc-meta">${g.members.length} members · ${g.expenses.length} expenses</div>
            </div>
          </div>
          <div class="gc-stats">
            <div class="gc-stat-item">
              <div class="gc-stat-val">${fmt(total)}</div>
              <div class="gc-stat-lbl">Total Spent</div>
            </div>
            <div class="gc-stat-item">
              <div class="gc-stat-val" style="color:${allSettled?'var(--green)':'var(--amber)'}">${allSettled ? '✓ All Settled' : fmt(totalOwed)}</div>
              <div class="gc-stat-lbl">Outstanding</div>
            </div>
          </div>
        </div>`;
    }).join('');
  },

  /* ── Group Detail ──────────────────────────────────── */
  groupDetail(groupId) {
    const group = Store.getGroup(groupId);
    if (!group) return;
    const icon = ICONS[group.type] || '👥';
    const total = r2(group.expenses.reduce((s, e) => s + e.amount, 0));
    document.getElementById('topbarTitle').textContent = group.name;

    document.getElementById('groupDetailHeader').innerHTML = `
      <div class="gdh-top">
        <span class="gdh-icon">${icon}</span>
        <div>
          <div class="gdh-name">${esc(group.name)}</div>
          <div class="gdh-meta">${group.members.length} members</div>
        </div>
      </div>
      <div class="gdh-total-lbl">Total Spent</div>
      <div class="gdh-total-amt">${fmt(total)}</div>
    `;

    // Balances
    const bals = Calc.groupBalances(groupId);
    const balDiv = document.getElementById('groupBalances');
    if (!bals.length) {
      balDiv.innerHTML = `<div style="padding:10px 0;color:var(--green);font-size:.88rem;font-weight:600">✓ All settled up in this group!</div>`;
    } else {
      balDiv.innerHTML = bals.map(b => {
        const f = Store.getFriend(b.friendId);
        return `
          <div class="balance-row">
            <div class="br-text"><strong>${esc(f?.name||'?')}</strong> owes you</div>
            <span class="br-amount">${fmt(b.amount)}</span>
            <button class="btn-settle" onclick="Actions.settleGroupMember('${groupId}','${b.friendId}',${b.amount})">Settle</button>
          </div>`;
      }).join('');
    }

    // Expenses
    document.getElementById('addGroupExpenseBtn').onclick = () => Modals.openAddGroupExpense(groupId);
    const expDiv = document.getElementById('groupExpenses');
    if (!group.expenses.length) {
      expDiv.innerHTML = `<div class="empty-state"><div class="empty-icon">💸</div><p>No expenses yet</p></div>`;
    } else {
      const sorted = [...group.expenses].sort((a, b) => new Date(b.date) - new Date(a.date));
      expDiv.innerHTML = sorted.map(exp => {
        const chips = exp.splits.map(sp => {
          const f = Store.getFriend(sp.friendId);
          const cls = sp.settled ? 'settled' : 'unsettled';
          return `<span class="gec-chip ${cls}">${esc(f?.name||'?')} ${fmt(sp.amount)}</span>`;
        }).join('');
        return `
          <div class="group-exp-card">
            <div class="gec-top">
              <div>
                <div class="gec-name">${esc(exp.name)}</div>
                <div class="gec-date">${fmtDate(exp.date)}${exp.note ? ' · ' + esc(exp.note) : ''}</div>
              </div>
              <div class="gec-amount">${fmt(exp.amount)}</div>
            </div>
            <div class="gec-splits">${chips}</div>
          </div>`;
      }).join('');
    }

    // Bottom actions
    const actDiv = document.getElementById('groupActions');
    const allSettled = bals.length === 0;
    if (allSettled && group.expenses.length > 0) {
      actDiv.innerHTML = `
        <button class="btn-full-green" onclick="Actions.settleAllInGroup('${groupId}')">✓ Settle All & Archive Group</button>
        <button class="btn-full-danger" onclick="Actions.deleteGroup('${groupId}')">🗑 Delete Group</button>
      `;
    } else if (bals.length > 0) {
      const totalOwed = r2(bals.reduce((s, b) => s + b.amount, 0));
      actDiv.innerHTML = `
        <button class="btn-full" onclick="Actions.settleAllInGroup('${groupId}')">Settle Everyone in Group — ${fmt(totalOwed)}</button>
      `;
    } else {
      actDiv.innerHTML = '';
    }
  },

  /* ── History ───────────────────────────────────────── */
  history() {
    Store._pruneHistory();
    const list = document.getElementById('historyList');
    if (!Store.history.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">🕐</div><p>No settled history yet</p></div>`;
      return;
    }
    const sorted = [...Store.history].sort((a, b) => new Date(b.settledAt) - new Date(a.settledAt));
    list.innerHTML = sorted.map(h => `
      <div class="history-card">
        <div class="hc-top">
          <div>
            <div class="hc-name">${esc(h.name)}</div>
            <div class="hc-meta">${esc(h.detail)} · Settled ${fmtDate(h.settledAt)}</div>
          </div>
          <span class="hc-badge">Settled</span>
        </div>
      </div>`).join('');
  },
};

/* ══════════════════════════════════════════════════════
   MODALS
══════════════════════════════════════════════════════ */
const Modals = {
  _pendingSettle: null,
  _billPeople: [],    // people being added to current bill
  _groupMembers: [],  // members being added to current group
  _activeGroupId: null,

  open(id)  { document.getElementById(id).classList.remove('hidden'); },
  close(id) { document.getElementById(id).classList.add('hidden'); },

  /* ── Add Friend ─────────────────────────────────────── */
  openAddFriend() {
    document.getElementById('fName').value    = '';
    document.getElementById('fContact').value = '';
    this.open('modalAddFriend');
    setTimeout(() => document.getElementById('fName').focus(), 150);
  },

  /* ── Add Bill ───────────────────────────────────────── */
  openAddBill() {
    this._billPeople = [];
    document.getElementById('bName').value   = '';
    document.getElementById('bAmount').value = '';
    document.getElementById('bDate').value   = today();
    document.getElementById('bNote').value   = '';
    document.getElementById('bPersonName').value    = '';
    document.getElementById('bPersonContact').value = '';
    this._renderBillFriendPicker();
    this._renderBillSplitRows();
    this.open('modalAddBill');
    setTimeout(() => document.getElementById('bName').focus(), 150);
  },

  _renderBillFriendPicker() {
    const picked = this._billPeople.map(p => p.contact);
    document.getElementById('billFriendPicker').innerHTML = Store.friends.map(f =>
      `<span class="fp-chip ${picked.includes(f.contact)?'selected':''}"
        onclick="Modals._toggleBillFriend('${f.id}')">${esc(f.name)}</span>`
    ).join('') || '<span style="color:var(--text3);font-size:.8rem">No friends yet</span>';
  },

  _toggleBillFriend(friendId) {
    const f = Store.getFriend(friendId);
    if (!f) return;
    const idx = this._billPeople.findIndex(p => p.contact === f.contact);
    if (idx >= 0) {
      this._billPeople.splice(idx, 1);
    } else {
      this._billPeople.push({ name: f.name, contact: f.contact, isExisting: true });
    }
    this._renderBillFriendPicker();
    this._renderBillSplitRows();
  },

  _renderBillSplitRows() {
    const rowsDiv = document.getElementById('billSplitRows');
    if (!this._billPeople.length) {
      rowsDiv.innerHTML = '<div style="color:var(--text3);font-size:.82rem;padding:8px 0">Add people above to split the bill</div>';
      document.getElementById('billSplitTotal').textContent = '₹0';
      document.getElementById('billSplitTotal').className = 'split-total-val';
      return;
    }
    rowsDiv.innerHTML = this._billPeople.map((p, i) =>
      `<div class="split-row">
        <span class="split-row-name">${esc(p.name)}</span>
        <input class="split-row-input" type="number" inputmode="decimal"
          id="bsplit_${i}" placeholder="0" oninput="Modals._updateBillTotal()"/>
        <button class="split-row-remove" onclick="Modals._removeBillPerson(${i})">✕</button>
      </div>`
    ).join('');
    this._updateBillTotal();
  },

  _updateBillTotal() {
    let sum = 0;
    this._billPeople.forEach((_, i) => {
      const v = parseFloat(document.getElementById(`bsplit_${i}`)?.value) || 0;
      sum += v;
    });
    const total = document.getElementById('billSplitTotal');
    const bAmt  = parseFloat(document.getElementById('bAmount').value) || 0;
    total.textContent = fmt(sum);
    if (bAmt > 0 && Math.abs(sum - bAmt) < 0.01) {
      total.className = 'split-total-val exact';
    } else if (sum > bAmt && bAmt > 0) {
      total.className = 'split-total-val over';
    } else {
      total.className = 'split-total-val';
    }
  },

  _removeBillPerson(idx) {
    this._billPeople.splice(idx, 1);
    this._renderBillFriendPicker();
    this._renderBillSplitRows();
  },

  /* ── Create Group ────────────────────────────────────── */
  openCreateGroup() {
    this._groupMembers = [];
    document.getElementById('gName').value = '';
    document.getElementById('gPersonName').value    = '';
    document.getElementById('gPersonContact').value = '';
    // reset type picker
    document.querySelectorAll('.type-chip').forEach((c, i) => c.classList.toggle('active', i === 0));
    this._renderGroupFriendPicker();
    this._renderGroupMemberTags();
    this.open('modalCreateGroup');
  },

  _renderGroupFriendPicker() {
    const picked = this._groupMembers.map(m => m.contact);
    document.getElementById('groupFriendPicker').innerHTML = Store.friends.map(f =>
      `<span class="fp-chip ${picked.includes(f.contact)?'selected':''}"
        onclick="Modals._toggleGroupMember('${f.id}')">${esc(f.name)}</span>`
    ).join('') || '<span style="color:var(--text3);font-size:.8rem">No friends yet</span>';
  },

  _toggleGroupMember(friendId) {
    const f = Store.getFriend(friendId);
    if (!f) return;
    const idx = this._groupMembers.findIndex(m => m.contact === f.contact);
    if (idx >= 0) this._groupMembers.splice(idx, 1);
    else this._groupMembers.push({ name: f.name, contact: f.contact });
    this._renderGroupFriendPicker();
    this._renderGroupMemberTags();
  },

  _renderGroupMemberTags() {
    document.getElementById('groupMembersList').innerHTML = this._groupMembers.map((m, i) =>
      `<span class="member-tag">${esc(m.name)}
        <button class="member-tag-remove" onclick="Modals._removeGroupMember(${i})">✕</button>
      </span>`
    ).join('') || '<span style="color:var(--text3);font-size:.8rem">No members added</span>';
  },

  _removeGroupMember(idx) {
    this._groupMembers.splice(idx, 1);
    this._renderGroupFriendPicker();
    this._renderGroupMemberTags();
  },

  /* ── Add Group Expense ────────────────────────────────── */
  openAddGroupExpense(groupId) {
    this._activeGroupId = groupId;
    const group = Store.getGroup(groupId);
    if (!group) return;
    document.getElementById('geName').value   = '';
    document.getElementById('geAmount').value = '';
    document.getElementById('geDate').value   = today();
    document.getElementById('geNote').value   = '';

    // Pre-fill split rows for each member
    const rows = document.getElementById('groupExpSplitRows');
    rows.innerHTML = group.members.map((fid, i) => {
      const f = Store.getFriend(fid);
      return `<div class="split-row">
        <span class="split-row-name">${esc(f?.name||'?')}</span>
        <input class="split-row-input" type="number" inputmode="decimal"
          id="gesplit_${fid}" placeholder="0" oninput="Modals._updateGroupExpTotal()"/>
      </div>`;
    }).join('');
    document.getElementById('groupExpSplitTotal').textContent = '₹0';
    this.open('modalAddGroupExpense');
  },

  _updateGroupExpTotal() {
    const group = Store.getGroup(this._activeGroupId);
    if (!group) return;
    let sum = 0;
    group.members.forEach(fid => {
      sum += parseFloat(document.getElementById(`gesplit_${fid}`)?.value) || 0;
    });
    const total = document.getElementById('groupExpSplitTotal');
    const gAmt  = parseFloat(document.getElementById('geAmount').value) || 0;
    total.textContent = fmt(sum);
    total.className = gAmt > 0 && Math.abs(sum - gAmt) < 0.01
      ? 'split-total-val exact'
      : sum > gAmt && gAmt > 0 ? 'split-total-val over' : 'split-total-val';
  },

  /* ── Settle ──────────────────────────────────────────── */
  openSettle(desc, amount, onConfirm) {
    this._pendingSettle = onConfirm;
    document.getElementById('settleBody').innerHTML = `
      <div class="settle-info">
        <div class="settle-desc">${desc}</div>
        <div class="settle-amt">${fmt(amount)}</div>
        <div class="settle-note">This will be marked as settled and moved to history.</div>
      </div>`;
    this.open('modalSettle');
  },
};

/* ══════════════════════════════════════════════════════
   ACTIONS – all business logic
══════════════════════════════════════════════════════ */
const Actions = {

  /* ── Add Friend ─────────────────────────────────────── */
  addFriend() {
    const name    = document.getElementById('fName').value.trim();
    const contact = document.getElementById('fContact').value.trim();
    if (!name)    { toast('⚠️ Please enter a name'); return; }
    if (!contact) { toast('⚠️ Please enter phone or email'); return; }

    if (Store.findByContact(contact)) {
      toast('⚠️ Friend with this contact already exists!'); return;
    }
    Store.upsertFriend(name, contact);
    Modals.close('modalAddFriend');
    toast(`✓ ${name} added!`);
    Render.home();
  },

  /* ── Save Bill ──────────────────────────────────────── */
  saveBill() {
    const name   = document.getElementById('bName').value.trim();
    const amount = parseFloat(document.getElementById('bAmount').value);
    const date   = document.getElementById('bDate').value || today();
    const note   = document.getElementById('bNote').value.trim();

    if (!name)          { toast('⚠️ Enter a bill name'); return; }
    if (!amount || amount <= 0) { toast('⚠️ Enter a valid amount'); return; }
    if (!Modals._billPeople.length) { toast('⚠️ Add at least one person'); return; }

    // Collect splits
    const splits = [];
    let totalAssigned = 0;
    for (let i = 0; i < Modals._billPeople.length; i++) {
      const p   = Modals._billPeople[i];
      const amt = parseFloat(document.getElementById(`bsplit_${i}`)?.value) || 0;
      if (amt <= 0) { toast(`⚠️ Enter amount for ${p.name}`); return; }
      totalAssigned += amt;

      // upsert friend (adds them if new)
      const friend = Store.upsertFriend(p.name, p.contact);
      splits.push({ friendId: friend.id, amount: r2(amt), settled: false });
    }

    // Validate total
    if (Math.abs(totalAssigned - amount) > 0.5) {
      toast(`⚠️ Split total ${fmt(totalAssigned)} doesn't match bill ${fmt(amount)}`); return;
    }

    Store.bills.push({ id: uid(), name, amount: r2(amount), date, note, splits });
    Store.save();
    Modals.close('modalAddBill');
    toast(`✓ Bill "${name}" saved!`);
    Render.bills();
    Render.home();
  },

  /* ── Save Group ─────────────────────────────────────── */
  saveGroup() {
    const name = document.getElementById('gName').value.trim();
    if (!name) { toast('⚠️ Enter a group name'); return; }
    if (!Modals._groupMembers.length) { toast('⚠️ Add at least one member'); return; }

    const type = document.querySelector('.type-chip.active')?.dataset.val || 'other';

    // Upsert all members
    const memberIds = Modals._groupMembers.map(m => Store.upsertFriend(m.name, m.contact).id);

    Store.groups.push({ id: uid(), name, type, members: memberIds, expenses: [] });
    Store.save();
    Modals.close('modalCreateGroup');
    toast(`✓ Group "${name}" created!`);
    Render.groups();
  },

  /* ── Save Group Expense ─────────────────────────────── */
  saveGroupExpense() {
    const groupId = Modals._activeGroupId;
    const group   = Store.getGroup(groupId);
    if (!group) return;

    const name   = document.getElementById('geName').value.trim();
    const amount = parseFloat(document.getElementById('geAmount').value);
    const date   = document.getElementById('geDate').value || today();
    const note   = document.getElementById('geNote').value.trim();

    if (!name)   { toast('⚠️ Enter expense name'); return; }
    if (!amount || amount <= 0) { toast('⚠️ Enter a valid amount'); return; }

    const splits = [];
    let totalAssigned = 0;
    for (const fid of group.members) {
      const amt = parseFloat(document.getElementById(`gesplit_${fid}`)?.value) || 0;
      if (amt > 0) {
        splits.push({ friendId: fid, amount: r2(amt), settled: false });
        totalAssigned += amt;
      }
    }

    if (!splits.length) { toast('⚠️ Enter at least one person\'s share'); return; }
    if (Math.abs(totalAssigned - amount) > 0.5) {
      toast(`⚠️ Split total ${fmt(totalAssigned)} doesn't match ${fmt(amount)}`); return;
    }

    group.expenses.push({ id: uid(), name, amount: r2(amount), date, note, splits });
    Store.save();
    Modals.close('modalAddGroupExpense');
    toast(`✓ "${name}" added to group!`);
    Render.groupDetail(groupId);
    Render.home();
  },

  /* ── Settle: single transaction from friend detail page */
  settleTransaction(friendId, sourceId, expId, type) {
    let amount = 0;
    if (type === 'bill') {
      const bill = Store.getBill(sourceId);
      const sp = bill?.splits.find(s => s.friendId === friendId);
      amount = sp?.amount || 0;
    } else {
      const group = Store.getGroup(sourceId);
      const exp   = group?.expenses.find(e => e.id === expId);
      const sp    = exp?.splits.find(s => s.friendId === friendId);
      amount = sp?.amount || 0;
    }
    const f = Store.getFriend(friendId);
    Modals.openSettle(
      `Settle with <strong>${esc(f?.name||'?')}</strong>`,
      amount,
      () => this._doSettleTransaction(friendId, sourceId, expId, type)
    );
  },

  _doSettleTransaction(friendId, sourceId, expId, type) {
    const now = today();
    if (type === 'bill') {
      const bill = Store.getBill(sourceId);
      const sp   = bill?.splits.find(s => s.friendId === friendId);
      if (sp && !sp.settled) {
        sp.settled = true;
        Store.history.push({ id: uid(), name: bill.name, detail: `Bill with ${Store.getFriend(friendId)?.name}`, amount: sp.amount, settledAt: now });
      }
    } else {
      const group = Store.getGroup(sourceId);
      const exp   = group?.expenses.find(e => e.id === expId);
      const sp    = exp?.splits.find(s => s.friendId === friendId);
      if (sp && !sp.settled) {
        sp.settled = true;
        Store.history.push({ id: uid(), name: exp.name, detail: `Group expense with ${Store.getFriend(friendId)?.name}`, amount: sp.amount, settledAt: now });
      }
    }
    Store.save();
    Modals.close('modalSettle');
    toast('✓ Settled!');
    // Refresh current view
    Render.friendDetail(friendId);
    Render.home();
  },

  /* ── Settle all with one friend ─────────────────────── */
  settleAllWithFriend(friendId) {
    const f = Store.getFriend(friendId);
    const txns = Calc.friendTransactions(friendId).filter(t => !t.settled);
    const total = r2(txns.reduce((s, t) => s + t.amount, 0));
    Modals.openSettle(
      `Settle ALL with <strong>${esc(f?.name||'?')}</strong>`,
      total,
      () => {
        const now = today();
        for (const t of txns) {
          if (t.type === 'bill') {
            const sp = Store.getBill(t.sourceId)?.splits.find(s => s.friendId === friendId);
            if (sp) { sp.settled = true; Store.history.push({ id: uid(), name: t.name, detail: `Bill`, amount: sp.amount, settledAt: now }); }
          } else {
            const group = Store.getGroup(t.sourceId);
            const exp   = group?.expenses.find(e => e.id === t.expId);
            const sp    = exp?.splits.find(s => s.friendId === friendId);
            if (sp) { sp.settled = true; Store.history.push({ id: uid(), name: t.name, detail: `Group`, amount: sp.amount, settledAt: now }); }
          }
        }
        Store.save();
        Modals.close('modalSettle');
        toast(`✓ All settled with ${f?.name}!`);
        Render.friendDetail(friendId);
        Render.home();
      }
    );
  },

  /* ── Settle bill split (from bill detail page) ───────── */
  settleBillSplit(billId, friendId) {
    const bill = Store.getBill(billId);
    const sp   = bill?.splits.find(s => s.friendId === friendId);
    if (!sp || sp.settled) return;
    const f = Store.getFriend(friendId);
    Modals.openSettle(
      `${esc(f?.name||'?')} settles their share of <strong>${esc(bill.name)}</strong>`,
      sp.amount,
      () => {
        sp.settled = true;
        Store.history.push({ id: uid(), name: bill.name, detail: `Bill with ${f?.name}`, amount: sp.amount, settledAt: today() });
        Store.save();
        Modals.close('modalSettle');
        toast('✓ Settled!');
        Render.billDetail(billId);
        Render.home();
      }
    );
  },

  /* ── Settle one member in group ─────────────────────── */
  settleGroupMember(groupId, friendId, amount) {
    const f = Store.getFriend(friendId);
    const group = Store.getGroup(groupId);
    Modals.openSettle(
      `Settle <strong>${esc(f?.name||'?')}</strong> in <strong>${esc(group?.name||'?')}</strong>`,
      amount,
      () => {
        const now = today();
        for (const exp of group.expenses) {
          const sp = exp.splits.find(s => s.friendId === friendId);
          if (sp && !sp.settled) {
            sp.settled = true;
            Store.history.push({ id: uid(), name: exp.name, detail: `${group.name} · ${f?.name}`, amount: sp.amount, settledAt: now });
          }
        }
        Store.save();
        Modals.close('modalSettle');
        toast(`✓ ${f?.name} settled in ${group.name}!`);
        Render.groupDetail(groupId);
        Render.home();
      }
    );
  },

  /* ── Settle everyone in group ────────────────────────── */
  settleAllInGroup(groupId) {
    const group = Store.getGroup(groupId);
    const bals  = Calc.groupBalances(groupId);
    const total = r2(bals.reduce((s, b) => s + b.amount, 0));
    Modals.openSettle(
      `Settle everyone in <strong>${esc(group?.name||'?')}</strong>`,
      total,
      () => {
        const now = today();
        for (const exp of group.expenses) {
          for (const sp of exp.splits) {
            if (!sp.settled) {
              sp.settled = true;
              const f = Store.getFriend(sp.friendId);
              Store.history.push({ id: uid(), name: exp.name, detail: `${group.name} · ${f?.name}`, amount: sp.amount, settledAt: now });
            }
          }
        }
        Store.save();
        Modals.close('modalSettle');
        toast(`✓ All settled in ${group.name}!`);
        Render.groupDetail(groupId);
        Render.home();
      }
    );
  },

  /* ── Delete group ────────────────────────────────────── */
  deleteGroup(groupId) {
    const group = Store.getGroup(groupId);
    if (!confirm(`Delete group "${group?.name}"? This cannot be undone.`)) return;
    Store.groups = Store.groups.filter(g => g.id !== groupId);
    Store.save();
    toast('Group deleted');
    Nav.back();
    Render.groups();
  },

  /* ── Add person to bill (inline) ─────────────────────── */
  addPersonToBill() {
    const name    = document.getElementById('bPersonName').value.trim();
    const contact = document.getElementById('bPersonContact').value.trim();
    if (!name || !contact) { toast('⚠️ Enter name and phone/email'); return; }
    if (Modals._billPeople.find(p => p.contact.toLowerCase() === contact.toLowerCase())) {
      toast('⚠️ Person already added'); return;
    }
    Modals._billPeople.push({ name, contact });
    document.getElementById('bPersonName').value    = '';
    document.getElementById('bPersonContact').value = '';
    Modals._renderBillFriendPicker();
    Modals._renderBillSplitRows();
  },

  /* ── Add person to group (inline) ────────────────────── */
  addPersonToGroup() {
    const name    = document.getElementById('gPersonName').value.trim();
    const contact = document.getElementById('gPersonContact').value.trim();
    if (!name || !contact) { toast('⚠️ Enter name and phone/email'); return; }
    if (Modals._groupMembers.find(m => m.contact.toLowerCase() === contact.toLowerCase())) {
      toast('⚠️ Person already added'); return;
    }
    Modals._groupMembers.push({ name, contact });
    document.getElementById('gPersonName').value    = '';
    document.getElementById('gPersonContact').value = '';
    Modals._renderGroupFriendPicker();
    Modals._renderGroupMemberTags();
  },

  /* ── Confirm settle (from modal) ─────────────────────── */
  confirmSettle() {
    if (Modals._pendingSettle) Modals._pendingSettle();
  },
};

/* ══════════════════════════════════════════════════════
   UTILS
══════════════════════════════════════════════════════ */
const initials = name => (name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2);
const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

/* ══════════════════════════════════════════════════════
   TYPE PICKER INIT
══════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Type chip toggle
  document.querySelectorAll('.type-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.type-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    });
  });
});

/* ══════════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  Store.init();

  // Back button
  document.getElementById('backBtn').addEventListener('click', () => Nav.back());

  // Register PWA service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Bill amount input triggers total update
  document.getElementById('bAmount').addEventListener('input', () => Modals._updateBillTotal());
  document.getElementById('geAmount').addEventListener('input', () => Modals._updateGroupExpTotal());

  // Hide splash, show app
  setTimeout(() => {
    document.getElementById('app').classList.remove('hidden');
    Render.home();
  }, 2100);
});
