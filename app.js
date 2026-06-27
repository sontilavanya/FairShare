'use strict';
/**
 * FairShare – app.js
 * ─────────────────────────────────────────────────────────────
 * Modules:
 *  DB        – localStorage persistence
 *  Store     – in-memory data + computed balances
 *  UI        – page routing, modal management, rendering
 *  App       – business logic (save/delete expense, settle, etc.)
 *  Reminders – recurring expense scheduler
 */

/* ══════════════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════════════ */
const CATEGORIES = [
  { id: 'food',      label: 'Food',      icon: '🍔' },
  { id: 'travel',    label: 'Travel',    icon: '✈️' },
  { id: 'stay',      label: 'Stay',      icon: '🏨' },
  { id: 'drinks',    label: 'Drinks',    icon: '🍺' },
  { id: 'shopping',  label: 'Shopping',  icon: '🛍️' },
  { id: 'fuel',      label: 'Fuel',      icon: '⛽' },
  { id: 'bills',     label: 'Bills',     icon: '📄' },
  { id: 'rent',      label: 'Rent',      icon: '🏠' },
  { id: 'ent',       label: 'Fun',       icon: '🎬' },
  { id: 'other',     label: 'Other',     icon: '📦' },
];

const GROUP_TYPES = [
  { id: 'trip',      label: 'Trip',   icon: '✈️' },
  { id: 'home',      label: 'Home',   icon: '🏠' },
  { id: 'couple',    label: 'Couple', icon: '💑' },
  { id: 'work',      label: 'Work',   icon: '💼' },
  { id: 'other',     label: 'Other',  icon: '👥' },
];

const AVATAR_COLOURS = [
  '#7c3aed','#2563eb','#059669','#dc2626',
  '#d97706','#db2777','#0891b2','#65a30d',
];

const ME = { id: 'me', name: 'You', colour: '#7c3aed' };

/* ══════════════════════════════════════════════════════════════
   DB  – localStorage wrapper
══════════════════════════════════════════════════════════════ */
const DB = {
  KEY: 'fairshare_v1',

  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },

  save(data) {
    try { localStorage.setItem(this.KEY, JSON.stringify(data)); } catch {}
  },

  defaultData() {
    return { friends: [], groups: [], expenses: [], payments: [], nextId: 1 };
  },
};

/* ══════════════════════════════════════════════════════════════
   STORE  – in-memory state + computed helpers
══════════════════════════════════════════════════════════════ */
const Store = {
  friends: [],
  groups: [],
  expenses: [],
  payments: [],
  nextId: 1,

  init() {
    const data = DB.load() || DB.defaultData();
    Object.assign(this, data);
  },

  persist() {
    DB.save({
      friends:  this.friends,
      groups:   this.groups,
      expenses: this.expenses,
      payments: this.payments,
      nextId:   this.nextId,
    });
  },

  uid() { return this.nextId++; },

  /** All people including "me" */
  allPeople() { return [ME, ...this.friends]; },

  getPerson(id) { return id === 'me' ? ME : this.friends.find(f => f.id === id); },
  getGroup(id)  { return this.groups.find(g => g.id === id); },

  /**
   * Compute net balance per friend.
   * Returns { friendId → amount }  positive = they owe me, negative = I owe them
   */
  balances() {
    const bal = {};
    this.friends.forEach(f => { bal[f.id] = 0; });

    for (const exp of this.expenses) {
      if (exp.deleted) continue;
      const paidBy = exp.paidBy;
      const splits = exp.splits; // [{personId, amount}]

      for (const s of splits) {
        if (paidBy === 'me' && s.personId !== 'me') {
          // I paid, friend owes me
          bal[s.personId] = (bal[s.personId] || 0) + s.amount;
        } else if (paidBy !== 'me' && s.personId === 'me') {
          // Friend paid, I owe friend
          bal[paidBy] = (bal[paidBy] || 0) - s.amount;
        }
      }
    }

    // Apply payments
    for (const p of this.payments) {
      if (p.deleted) continue;
      // payer paid payee
      if (p.payer === 'me') {
        bal[p.payee] = (bal[p.payee] || 0) - p.amount;
      } else if (p.payee === 'me') {
        bal[p.payer] = (bal[p.payer] || 0) + p.amount;
      }
    }

    return bal;
  },

  /** Balances within a specific group */
  groupBalances(groupId) {
    const group = this.getGroup(groupId);
    if (!group) return [];
    const members = group.members; // ['me', friendId, ...]

    // Simplified: for each expense in this group compute who owes whom
    const owes = {}; // 'personA→personB' → amount
    const expenses = this.expenses.filter(e => e.groupId === groupId && !e.deleted);

    for (const exp of expenses) {
      const { paidBy, splits } = exp;
      for (const s of splits) {
        if (s.personId === paidBy) continue;
        const key = `${s.personId}→${paidBy}`;
        owes[key] = (owes[key] || 0) + s.amount;
      }
    }

    // Simplify debts
    const result = [];
    for (const [key, amt] of Object.entries(owes)) {
      if (amt < 0.01) continue;
      const [from, to] = key.split('→');
      result.push({ from, to, amount: amt });
    }
    return result;
  },

  totalSpent() {
    return this.expenses
      .filter(e => !e.deleted && e.paidBy === 'me')
      .reduce((s, e) => s + e.amount, 0);
  },

  spentByCategory() {
    const cats = {};
    for (const e of this.expenses) {
      if (e.deleted) continue;
      cats[e.category] = (cats[e.category] || 0) + e.amount;
    }
    return cats;
  },

  monthlyTrend() {
    const months = {};
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      months[key] = 0;
    }
    for (const e of this.expenses) {
      if (e.deleted) continue;
      const key = e.date.slice(0, 7);
      if (months[key] !== undefined) months[key] += e.amount;
    }
    return months;
  },
};

/* ══════════════════════════════════════════════════════════════
   UI
══════════════════════════════════════════════════════════════ */
const UI = {
  currentPage: 'pageHome',
  pageStack: [],

  init() {
    // Bottom nav
    document.querySelectorAll('.nav-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => this.showPage(btn.dataset.page));
    });
    // Back btn
    document.getElementById('backBtn').addEventListener('click', () => this.goBack());
    // Filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderActivity(btn.dataset.filter);
      });
    });
    // Recurring toggle
    document.getElementById('expRecurring').addEventListener('change', e => {
      document.getElementById('expRecurFreq').classList.toggle('hidden', !e.target.checked);
    });
    // Split type
    document.querySelectorAll('.split-type').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.split-type').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.updateSplitUI(btn.dataset.type);
      });
    });
    // Expense group change
    document.getElementById('expGroup').addEventListener('change', () => {
      this.populateSplitMembers();
    });
  },

  /* ── Page routing ────────────────────────────────────── */
  showPage(pageId, pushStack = true) {
    if (pageId === this.currentPage && pushStack) return;

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId).classList.add('active');

    // Nav highlight
    document.querySelectorAll('.nav-btn[data-page]').forEach(b => {
      b.classList.toggle('active', b.dataset.page === pageId);
    });

    // Topbar
    const titles = {
      pageHome: 'FairShare', pageGroups: 'Groups',
      pageGroupDetail: '', pageActivity: 'Activity', pageAnalytics: 'Analytics',
    };
    document.getElementById('topbarTitle').textContent = titles[pageId] || '';

    const backBtn = document.getElementById('backBtn');
    backBtn.classList.toggle('hidden', ['pageHome','pageGroups','pageActivity','pageAnalytics'].includes(pageId));

    if (pushStack && pageId !== this.currentPage) this.pageStack.push(this.currentPage);
    this.currentPage = pageId;

    this.renderPage(pageId);
  },

  goBack() {
    const prev = this.pageStack.pop();
    if (prev) this.showPage(prev, false);
  },

  renderPage(pageId) {
    switch (pageId) {
      case 'pageHome':        this.renderHome(); break;
      case 'pageGroups':      this.renderGroups(); break;
      case 'pageGroupDetail': this.renderGroupDetail(App.currentGroupId); break;
      case 'pageActivity':    this.renderActivity('all'); break;
      case 'pageAnalytics':   this.renderAnalytics(); break;
    }
  },

  /* ── Render: Home ────────────────────────────────────── */
  renderHome() {
    const bals = Store.balances();
    let totalOwedToMe = 0, totalIOwe = 0;
    for (const [id, amt] of Object.entries(bals)) {
      if (amt > 0) totalOwedToMe += amt;
      else totalIOwe += Math.abs(amt);
    }
    const net = totalOwedToMe - totalIOwe;

    document.getElementById('heroOwed').textContent  = fmt(net);
    document.getElementById('heroOwe').textContent   = `You owe ${fmt(totalIOwe)}`;
    document.getElementById('heroOwn').textContent   = `Owed to you ${fmt(totalOwedToMe)}`;

    const list = document.getElementById('friendsList');
    if (!Store.friends.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">👋</div><p>Add friends to start splitting</p></div>`;
      return;
    }

    list.innerHTML = Store.friends.map(f => {
      const bal = bals[f.id] || 0;
      const cls = bal > 0.01 ? 'positive' : bal < -0.01 ? 'negative' : 'zero';
      const label = bal > 0.01 ? `owes you ${fmt(bal)}` : bal < -0.01 ? `you owe ${fmt(Math.abs(bal))}` : 'settled up';
      return `
        <div class="friend-card" onclick="UI.openFriendDetail('${f.id}')">
          <div class="avatar" style="background:${f.colour}">${initials(f.name)}</div>
          <div class="friend-info">
            <div class="friend-name">${f.name}</div>
            <div class="friend-sub">${f.contact || 'No contact'}</div>
          </div>
          <div class="friend-balance ${cls}">${fmt(Math.abs(bal))}</div>
        </div>`;
    }).join('');
  },

  /* ── Render: Groups ──────────────────────────────────── */
  renderGroups() {
    const list = document.getElementById('groupsList');
    if (!Store.groups.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">🏠</div><p>No groups yet. Create one!</p></div>`;
      return;
    }
    list.innerHTML = Store.groups.map(g => {
      const exps = Store.expenses.filter(e => e.groupId === g.id && !e.deleted);
      const total = exps.reduce((s, e) => s + e.amount, 0);
      const gtype = GROUP_TYPES.find(t => t.id === g.type) || GROUP_TYPES[4];
      return `
        <div class="group-card" onclick="UI.openGroup('${g.id}')">
          <div class="group-card-top">
            <span class="group-icon">${gtype.icon}</span>
            <div>
              <div class="group-card-name">${g.name}</div>
              <div class="group-card-sub">${g.members.length} members · ${exps.length} expenses</div>
            </div>
          </div>
          <div class="group-card-bal">
            <span class="group-bal-label">Total spent</span>
            <span class="group-bal-val">${fmt(total)}</span>
          </div>
        </div>`;
    }).join('');
  },

  /* ── Render: Group detail ────────────────────────────── */
  renderGroupDetail(groupId) {
    const group = Store.getGroup(groupId);
    if (!group) return;
    const gtype = GROUP_TYPES.find(t => t.id === group.type) || GROUP_TYPES[4];
    const exps = Store.expenses.filter(e => e.groupId === groupId && !e.deleted);
    const total = exps.reduce((s, e) => s + e.amount, 0);

    document.getElementById('topbarTitle').textContent = group.name;
    document.getElementById('groupHero').innerHTML = `
      <div style="font-size:2rem;margin-bottom:8px">${gtype.icon}</div>
      <div style="font-size:1.2rem;font-weight:800;color:var(--text)">${group.name}</div>
      <div style="font-size:.8rem;color:var(--text-2);margin-top:4px">${group.members.length} members · Total ${fmt(total)}</div>
    `;

    // Balances
    const bals = Store.groupBalances(groupId);
    const balDiv = document.getElementById('groupBalances');
    if (!bals.length) {
      balDiv.innerHTML = '<div style="color:var(--text-3);font-size:.85rem;padding:8px 0">✅ All settled up!</div>';
    } else {
      balDiv.innerHTML = bals.map(b => {
        const from = Store.getPerson(b.from);
        const to   = Store.getPerson(b.to);
        return `
          <div class="settle-row">
            <span class="settle-text">${from?.name || '?'} owes ${to?.name || '?'}</span>
            <span class="settle-amount">${fmt(b.amount)}</span>
            <button class="settle-btn" onclick="UI.openSettle('${b.from}','${b.to}',${b.amount},'${groupId}')">Settle</button>
          </div>`;
      }).join('');
    }

    // Expenses
    const expDiv = document.getElementById('groupExpenses');
    expDiv.innerHTML = exps.length ? exps.map(e => expenseHTML(e)).join('') :
      '<div class="empty-state"><div class="empty-icon">💸</div><p>No expenses yet</p></div>';
  },

  /* ── Render: Activity ────────────────────────────────── */
  renderActivity(filter) {
    const list = document.getElementById('activityList');
    let items = [
      ...Store.expenses.filter(e => !e.deleted).map(e => ({ ...e, _type: 'expense' })),
      ...Store.payments.filter(p => !p.deleted).map(p => ({ ...p, _type: 'payment' })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));

    if (filter === 'expense') items = items.filter(i => i._type === 'expense');
    if (filter === 'payment') items = items.filter(i => i._type === 'payment');

    if (!items.length) {
      list.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><p>No activity yet</p></div>';
      return;
    }
    list.innerHTML = items.map(item => {
      if (item._type === 'expense') {
        const cat = CATEGORIES.find(c => c.id === item.category) || CATEGORIES[9];
        const myShare = item.splits.find(s => s.personId === 'me')?.amount || 0;
        const paidByMe = item.paidBy === 'me';
        return `
          <div class="activity-item">
            <div class="act-icon">${cat.icon}</div>
            <div class="act-info">
              <div class="act-desc">${item.desc}</div>
              <div class="act-meta">${formatDate(item.date)} · Paid by ${Store.getPerson(item.paidBy)?.name || '?'}</div>
            </div>
            <div class="act-amount" style="color:${paidByMe ? 'var(--green)' : 'var(--red)'}">
              ${paidByMe ? '+' : '-'}${fmt(myShare)}
            </div>
          </div>`;
      } else {
        const payer = Store.getPerson(item.payer);
        const payee = Store.getPerson(item.payee);
        return `
          <div class="activity-item">
            <div class="act-icon">💸</div>
            <div class="act-info">
              <div class="act-desc">${payer?.name} paid ${payee?.name}</div>
              <div class="act-meta">${formatDate(item.date)}</div>
            </div>
            <div class="act-amount" style="color:var(--green)">${fmt(item.amount)}</div>
          </div>`;
      }
    }).join('');
  },

  /* ── Render: Analytics ───────────────────────────────── */
  renderAnalytics() {
    const bals = Store.balances();
    let owed = 0, iOwe = 0;
    for (const amt of Object.values(bals)) {
      if (amt > 0) owed += amt; else iOwe += Math.abs(amt);
    }
    const totalSpent = Store.totalSpent();
    const numExp = Store.expenses.filter(e => !e.deleted).length;

    document.getElementById('analyticsCards').innerHTML = `
      <div class="ana-card">
        <div class="ana-card-label">Total Spent</div>
        <div class="ana-card-val">${fmt(totalSpent)}</div>
        <div class="ana-card-sub">${numExp} expenses</div>
      </div>
      <div class="ana-card">
        <div class="ana-card-label">Owed to You</div>
        <div class="ana-card-val" style="color:var(--green)">${fmt(owed)}</div>
        <div class="ana-card-sub">from ${Store.friends.length} friends</div>
      </div>
      <div class="ana-card">
        <div class="ana-card-label">You Owe</div>
        <div class="ana-card-val" style="color:var(--red)">${fmt(iOwe)}</div>
        <div class="ana-card-sub">net balance</div>
      </div>
      <div class="ana-card">
        <div class="ana-card-label">Groups</div>
        <div class="ana-card-val">${Store.groups.length}</div>
        <div class="ana-card-sub">active groups</div>
      </div>
    `;

    // Category bars
    const catSpend = Store.spentByCategory();
    const maxCat = Math.max(...Object.values(catSpend), 1);
    const catColours = ['#7c3aed','#2563eb','#059669','#d97706','#dc2626','#db2777','#0891b2','#65a30d','#f59e0b','#6b7280'];
    document.getElementById('categoryBars').innerHTML = Object.entries(catSpend)
      .sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([catId, amt], i) => {
        const cat = CATEGORIES.find(c => c.id === catId) || CATEGORIES[9];
        const pct = Math.round((amt / maxCat) * 100);
        return `
          <div class="cat-bar-row">
            <div class="cat-bar-top">
              <span class="cat-bar-name">${cat.icon} ${cat.label}</span>
              <span class="cat-bar-amt">${fmt(amt)}</span>
            </div>
            <div class="cat-bar-track">
              <div class="cat-bar-fill" style="width:${pct}%;background:${catColours[i]}"></div>
            </div>
          </div>`;
      }).join('') || '<div class="empty-state"><p>No spending data yet</p></div>';

    // Monthly trend
    const trend = Store.monthlyTrend();
    const maxTrend = Math.max(...Object.values(trend), 1);
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    document.getElementById('trendChart').innerHTML = Object.entries(trend).map(([key, amt]) => {
      const month = monthNames[parseInt(key.split('-')[1]) - 1];
      const h = Math.max(4, Math.round((amt / maxTrend) * 80));
      return `
        <div class="trend-bar-wrap">
          <div class="trend-bar" style="height:${h}px" title="${fmt(amt)}"></div>
          <div class="trend-lbl">${month}</div>
        </div>`;
    }).join('');
  },

  /* ── Modals ──────────────────────────────────────────── */
  openModal(id)  { document.getElementById(id).classList.remove('hidden'); },
  closeModal(id) { document.getElementById(id).classList.add('hidden'); },

  openAddFriend() {
    document.getElementById('friendName').value    = '';
    document.getElementById('friendContact').value = '';
    // Avatar colours
    document.getElementById('avatarColours').innerHTML = AVATAR_COLOURS.map((c, i) =>
      `<div class="av-col ${i===0?'active':''}" style="background:${c}" data-colour="${c}" onclick="UI.selectAvatarColour(this)"></div>`
    ).join('');
    this.openModal('modalFriend');
    setTimeout(() => document.getElementById('friendName').focus(), 100);
  },

  selectAvatarColour(el) {
    document.querySelectorAll('.av-col').forEach(e => e.classList.remove('active'));
    el.classList.add('active');
  },

  openCreateGroup() {
    document.getElementById('groupName').value = '';
    // Group type picker
    document.getElementById('groupTypePicker').innerHTML = GROUP_TYPES.map((t, i) =>
      `<button class="gtype-chip ${i===0?'active':''}" data-id="${t.id}" onclick="UI.selectGroupType(this)">${t.icon} ${t.label}</button>`
    ).join('');
    // Member checkboxes
    const mc = document.getElementById('memberCheckboxes');
    if (!Store.friends.length) {
      mc.innerHTML = '<div class="empty-state" style="padding:12px 0"><p>Add friends first</p></div>';
    } else {
      mc.innerHTML = Store.friends.map(f =>
        `<div class="member-check-row">
          <input type="checkbox" id="mc_${f.id}" value="${f.id}"/>
          <div class="avatar" style="background:${f.colour};width:30px;height:30px;font-size:.75rem">${initials(f.name)}</div>
          <label for="mc_${f.id}">${f.name}</label>
        </div>`
      ).join('');
    }
    this.openModal('modalGroup');
  },

  selectGroupType(el) {
    document.querySelectorAll('.gtype-chip').forEach(e => e.classList.remove('active'));
    el.classList.add('active');
  },

  openAddExpense(groupId = null) {
    // Reset form
    document.getElementById('expDesc').value   = '';
    document.getElementById('expAmount').value = '';
    document.getElementById('expNote').value   = '';
    document.getElementById('expDate').value   = today();
    document.getElementById('expRecurring').checked = false;
    document.getElementById('expRecurFreq').classList.add('hidden');
    document.querySelectorAll('.split-type').forEach((b,i) => b.classList.toggle('active', i===0));
    document.getElementById('splitCustom').classList.add('hidden');

    // Category picker
    document.getElementById('categoryPicker').innerHTML = CATEGORIES.map((c, i) =>
      `<button class="cat-chip ${i===0?'active':''}" data-id="${c.id}" onclick="UI.selectCategory(this)">${c.icon} ${c.label}</button>`
    ).join('');

    // Paid by
    const paidBy = document.getElementById('expPaidBy');
    paidBy.innerHTML = Store.allPeople().map(p =>
      `<option value="${p.id}" ${p.id==='me'?'selected':''}>${p.name}</option>`
    ).join('');

    // Group select
    const grpSel = document.getElementById('expGroup');
    grpSel.innerHTML = '<option value="">No group</option>' +
      Store.groups.map(g => `<option value="${g.id}" ${g.id===groupId?'selected':''}>${g.name}</option>`).join('');

    this.populateSplitMembers();
    this.openModal('modalExpense');
    setTimeout(() => document.getElementById('expDesc').focus(), 100);
  },

  selectCategory(el) {
    document.querySelectorAll('.cat-chip').forEach(e => e.classList.remove('active'));
    el.classList.add('active');
  },

  populateSplitMembers() {
    const groupId = document.getElementById('expGroup').value;
    let people;
    if (groupId) {
      const group = Store.getGroup(groupId);
      people = group ? group.members.map(id => Store.getPerson(id)).filter(Boolean) : Store.allPeople();
    } else {
      people = Store.allPeople();
    }

    document.getElementById('splitMembers').innerHTML = people.map(p =>
      `<div class="split-member-row">
        <input class="split-member-check" type="checkbox" id="sm_${p.id}" value="${p.id}" checked/>
        <div class="avatar" style="background:${p.colour||'#7c3aed'};width:28px;height:28px;font-size:.7rem">${initials(p.name)}</div>
        <label class="split-member-name" for="sm_${p.id}">${p.name}</label>
        <span class="split-member-share" id="sms_${p.id}"></span>
      </div>`
    ).join('');

    // Update share preview on amount change
    const updateShares = () => {
      const amt = parseFloat(document.getElementById('expAmount').value) || 0;
      const checked = [...document.querySelectorAll('.split-member-check:checked')];
      const share = checked.length ? amt / checked.length : 0;
      document.querySelectorAll('.split-member-share').forEach(el => { el.textContent = ''; });
      checked.forEach(c => {
        const el = document.getElementById(`sms_${c.value}`);
        if (el) el.textContent = fmt(share);
      });
    };
    document.getElementById('expAmount').addEventListener('input', updateShares);
    document.querySelectorAll('.split-member-check').forEach(c => c.addEventListener('change', updateShares));
  },

  updateSplitUI(type) {
    const custom = document.getElementById('splitCustom');
    if (type === 'equal') {
      custom.classList.add('hidden');
      return;
    }
    custom.classList.remove('hidden');
    const checked = [...document.querySelectorAll('.split-member-check:checked')];
    const amt = parseFloat(document.getElementById('expAmount').value) || 0;
    const unit = type === 'percent' ? '%' : '₹';
    const defaultVal = type === 'percent'
      ? (checked.length ? Math.round(100 / checked.length) : 0)
      : (checked.length ? (amt / checked.length).toFixed(2) : 0);

    custom.innerHTML = checked.map(c => {
      const p = Store.getPerson(c.value);
      return `
        <div class="split-custom-row">
          <span class="split-custom-name">${p?.name || '?'}</span>
          <input class="split-custom-input" type="number" id="scv_${c.value}" value="${defaultVal}" placeholder="0"/>
          <span style="color:var(--text-2);font-size:.85rem">${unit}</span>
        </div>`;
    }).join('');
  },

  openGroup(groupId) {
    App.currentGroupId = groupId;
    this.pageStack.push(this.currentPage);
    this.currentPage = 'pageGroupDetail';
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('pageGroupDetail').classList.add('active');
    document.getElementById('backBtn').classList.remove('hidden');
    document.querySelectorAll('.nav-btn[data-page]').forEach(b => b.classList.remove('active'));
    this.renderGroupDetail(groupId);
  },

  openFriendDetail(friendId) {
    // Show activity filtered by friend
    this.showPage('pageActivity');
    // TODO: filter by friend — for now shows all
  },

  openSettle(fromId, toId, amount, groupId) {
    App.pendingSettle = { fromId, toId, amount, groupId };
    const from = Store.getPerson(fromId);
    const to   = Store.getPerson(toId);
    document.getElementById('settleBody').innerHTML = `
      <div class="settle-confirm">
        <p><strong>${from?.name}</strong> pays <strong>${to?.name}</strong></p>
        <span class="settle-amount-big">${fmt(amount)}</span>
        <p style="color:var(--text-2);font-size:.85rem">This will be recorded as a payment and balances will update.</p>
      </div>`;
    this.openModal('modalSettle');
  },

  toast(msg, duration = 2200) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
  },
};

/* ══════════════════════════════════════════════════════════════
   APP  – business logic
══════════════════════════════════════════════════════════════ */
const App = {
  currentGroupId: null,
  pendingSettle: null,

  /* ── Save friend ─────────────────────────────────────── */
  saveFriend() {
    const name = document.getElementById('friendName').value.trim();
    if (!name) { UI.toast('Please enter a name'); return; }
    const colour = document.querySelector('.av-col.active')?.dataset.colour || AVATAR_COLOURS[0];
    const contact = document.getElementById('friendContact').value.trim();
    const friend = { id: Store.uid(), name, colour, contact };
    Store.friends.push(friend);
    Store.persist();
    UI.closeModal('modalFriend');
    UI.toast(`${name} added!`);
    UI.renderHome();
  },

  /* ── Save group ──────────────────────────────────────── */
  saveGroup() {
    const name = document.getElementById('groupName').value.trim();
    if (!name) { UI.toast('Please enter a group name'); return; }
    const type = document.querySelector('.gtype-chip.active')?.dataset.id || 'other';
    const members = ['me', ...[...document.querySelectorAll('#memberCheckboxes input:checked')].map(c => c.value)];
    const group = { id: Store.uid(), name, type, members };
    Store.groups.push(group);
    Store.persist();
    UI.closeModal('modalGroup');
    UI.toast(`Group "${name}" created!`);
    UI.renderGroups();
  },

  /* ── Save expense ────────────────────────────────────── */
  saveExpense() {
    const desc   = document.getElementById('expDesc').value.trim();
    const amount = parseFloat(document.getElementById('expAmount').value);
    if (!desc)         { UI.toast('Add a description'); return; }
    if (!amount || amount <= 0) { UI.toast('Enter a valid amount'); return; }

    const category   = document.querySelector('.cat-chip.active')?.dataset.id || 'other';
    const paidBy     = document.getElementById('expPaidBy').value;
    const groupId    = document.getElementById('expGroup').value || null;
    const note       = document.getElementById('expNote').value.trim();
    const date       = document.getElementById('expDate').value || today();
    const recurring  = document.getElementById('expRecurring').checked;
    const recurFreq  = recurring ? document.getElementById('expRecurFreq').value : null;

    // Build splits
    const splitType = document.querySelector('.split-type.active')?.dataset.type || 'equal';
    const checkedMembers = [...document.querySelectorAll('.split-member-check:checked')].map(c => c.value);
    if (!checkedMembers.length) { UI.toast('Select at least one person to split with'); return; }

    let splits = [];
    if (splitType === 'equal') {
      const share = amount / checkedMembers.length;
      splits = checkedMembers.map(id => ({ personId: id, amount: round2(share) }));
    } else if (splitType === 'percent') {
      let total = 0;
      splits = checkedMembers.map(id => {
        const pct = parseFloat(document.getElementById(`scv_${id}`)?.value) || 0;
        const amt = round2(amount * pct / 100);
        total += amt;
        return { personId: id, amount: amt };
      });
    } else {
      splits = checkedMembers.map(id => {
        const amt = round2(parseFloat(document.getElementById(`scv_${id}`)?.value) || 0);
        return { personId: id, amount: amt };
      });
    }

    const expense = {
      id: Store.uid(), desc, amount, category, paidBy,
      groupId, note, date, recurring, recurFreq, splits,
      deleted: false, createdAt: new Date().toISOString(),
    };
    Store.expenses.push(expense);
    Store.persist();
    UI.closeModal('modalExpense');
    UI.toast(`"${desc}" added!`);

    // Refresh current page
    if (App.currentGroupId && groupId === App.currentGroupId) {
      UI.renderGroupDetail(App.currentGroupId);
    }
    UI.renderHome();
  },

  /* ── Confirm settle ──────────────────────────────────── */
  confirmSettle() {
    if (!this.pendingSettle) return;
    const { fromId, toId, amount } = this.pendingSettle;
    Store.payments.push({
      id: Store.uid(), payer: fromId, payee: toId,
      amount: round2(amount), date: today(),
      deleted: false, createdAt: new Date().toISOString(),
    });
    Store.persist();
    UI.closeModal('modalSettle');
    UI.toast('Payment recorded! ✅');
    UI.renderHome();
    if (App.currentGroupId) UI.renderGroupDetail(App.currentGroupId);
    this.pendingSettle = null;
  },
};

/* ══════════════════════════════════════════════════════════════
   REMINDERS  – recurring expense scheduler
══════════════════════════════════════════════════════════════ */
const Reminders = {
  check() {
    const now = new Date();
    const todayStr = today();

    Store.expenses
      .filter(e => e.recurring && !e.deleted)
      .forEach(e => {
        const last = new Date(e.date);
        let nextDate = new Date(last);

        if (e.recurFreq === 'weekly')  nextDate.setDate(last.getDate() + 7);
        if (e.recurFreq === 'monthly') nextDate.setMonth(last.getMonth() + 1);
        if (e.recurFreq === 'yearly')  nextDate.setFullYear(last.getFullYear() + 1);

        const nextStr = nextDate.toISOString().slice(0, 10);
        if (nextStr <= todayStr) {
          // Auto-create a copy
          const copy = {
            ...e, id: Store.uid(), date: nextStr,
            createdAt: new Date().toISOString(),
          };
          // Update original's date so it rolls forward
          e.date = nextStr;
          Store.expenses.push(copy);
          Store.persist();
          UI.toast(`🔁 Recurring: "${e.desc}" added`);
        }
      });
  },
};

/* ══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════ */
const fmt = n => '₹' + Math.abs(n).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const round2 = n => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const initials = name => name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
const formatDate = str => {
  const d = new Date(str);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

function expenseHTML(e) {
  const cat = CATEGORIES.find(c => c.id === e.category) || CATEGORIES[9];
  const paidByMe = e.paidBy === 'me';
  const myShare = e.splits.find(s => s.personId === 'me')?.amount || 0;
  const shareClass = paidByMe ? 'lent' : 'owe';
  const shareLabel = paidByMe ? `you lent ${fmt(e.amount - myShare)}` : `you owe ${fmt(myShare)}`;
  return `
    <div class="expense-item">
      <div class="exp-cat-icon">${cat.icon}</div>
      <div class="exp-info">
        <div class="exp-desc">${e.desc}${e.recurring ? '<span class="exp-recurring">🔁 recurring</span>' : ''}</div>
        <div class="exp-meta">${formatDate(e.date)} · ${Store.getPerson(e.paidBy)?.name || '?'} paid</div>
      </div>
      <div class="exp-right">
        <div class="exp-amount">${fmt(e.amount)}</div>
        <div class="exp-share ${shareClass}">${shareLabel}</div>
      </div>
    </div>`;
}

/* ══════════════════════════════════════════════════════════════
   BOOT
══════════════════════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
  Store.init();
  UI.init();
  Reminders.check();

  // Register service worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // Hide splash and show app
  setTimeout(() => {
    document.getElementById('app').classList.remove('hidden');
    UI.renderHome();
  }, 2000);
});
