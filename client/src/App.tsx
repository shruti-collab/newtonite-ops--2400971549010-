import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, AlertTriangle, ArrowDownUp, CheckCircle2, ChevronDown, CircleHelp, Clock3, Command, Filter, LayoutDashboard, LogOut, Plus, RefreshCw, Search, ShieldCheck, Users, X } from "lucide-react";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000/api";
type User = { id: string; name: string; email: string; memberships: { teamId: string; role: string; team: { id: string; name: string } }[] };
type Item = { id: string; title: string; description: string; type: string; priority: string; status: string; teamId: string; team: { name: string }; assigneeId: string | null; assignee: { id: string; name: string } | null; createdBy: { name: string }; dueDate: string | null; version: number; createdAt: string; updatedAt: string; events?: any[]; comments?: any[] };
type Summary = { totalOpen: number; urgentUnassigned: number; awaitingApproval: number; overdue: number; byStatus: { status: string; count: number }[] };

async function api<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: any = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}
const label = (v: string) =>
  v.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c: string) => c.toUpperCase());const initials = (v: string) => v.split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase();

export default function App() {
  const qc = useQueryClient();
  const [token, setToken] = useState(() => localStorage.getItem("opspulse-token") || "");
  const [email, setEmail] = useState("admin@opspulse.local");
  const [password, setPassword] = useState("DemoPass123!");
  const [loginError, setLoginError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [focus, setFocus] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [toast, setToast] = useState("");
  const [createForm, setCreateForm] = useState({ title: "", description: "", type: "INCIDENT", priority: "HIGH", teamId: "", dueDate: "" });
  const [comment, setComment] = useState("");

  const loginMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${API}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Login failed");
      return data;
    },
    onSuccess: (data) => { localStorage.setItem("opspulse-token", data.token); setToken(data.token); setLoginError(""); },
    onError: (e: Error) => setLoginError(e.message)
  });
  const meQuery = useQuery<{ user: User }>({ queryKey: ["me", token], queryFn: () => api<{ user: User }>("/auth/me", token), enabled: !!token, retry: false });
  useEffect(() => {
    if (meQuery.isError) { localStorage.removeItem("opspulse-token"); setToken(""); }
  }, [meQuery.isError]);
  const user = meQuery.data?.user;
  const teamIds = user?.memberships.map((m) => m.teamId) || [];
  useEffect(() => {
    if (user && !createForm.teamId && teamIds[0]) setCreateForm((f) => ({ ...f, teamId: teamIds[0] }));
  }, [user, createForm.teamId, teamIds.join(",")]);

  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (status) params.set("status", status);
  if (priority) params.set("priority", priority);
  if (focus === "unassigned") params.set("priority", "URGENT");
  if (focus === "mine") params.set("assignee", "me");
  if (focus === "unassigned") params.set("assignee", "unassigned");
  if (focus === "approval") params.set("status", "AWAITING_APPROVAL");
  const itemsQuery = useQuery<{ items: Item[]; nextCursor: string | null }>({
    queryKey: ["items", token, search, status, priority, focus],
    queryFn: () => api<{ items: Item[]; nextCursor: string | null }>(`/items?${params.toString()}&limit=50`, token),
    enabled: !!token && !!user
  });
  const summaryQuery = useQuery<Summary>({ queryKey: ["summary", token], queryFn: () => api<Summary>("/dashboard/summary", token), enabled: !!token && !!user });
  const detailQuery = useQuery<{ item: Item }>({ queryKey: ["item", token, selectedId], queryFn: () => api<{ item: Item }>(`/items/${selectedId}`, token), enabled: !!token && !!selectedId });
  const items = itemsQuery.data?.items || [];
  const selected = detailQuery.data?.item;
  const roleForSelected = selected ? user?.memberships.find((m) => m.teamId === selected.teamId)?.role : undefined;
  const canEdit = ["MEMBER", "LEAD", "ADMIN"].includes(roleForSelected || "");
  const canLead = ["LEAD", "ADMIN"].includes(roleForSelected || "");

  const refresh = () => { qc.invalidateQueries({ queryKey: ["items"] }); qc.invalidateQueries({ queryKey: ["summary"] }); qc.invalidateQueries({ queryKey: ["item"] }); };
  const createMutation = useMutation({
    mutationFn: () => api<{ item: Item }>("/items", token, {
      method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ ...createForm, dueDate: createForm.dueDate ? new Date(createForm.dueDate).toISOString() : null })
    }),
    onSuccess: (data) => { setShowCreate(false); setCreateForm((f) => ({ ...f, title: "", description: "", dueDate: "" })); setSelectedId(data.item.id); refresh(); setToast("Work item created"); },
  });
  const claimMutation = useMutation({
    mutationFn: (id: string) => api(`/items/${id}/claim`, token, { method: "POST", body: "{}" }),
    onSuccess: () => { refresh(); setToast("Item claimed successfully"); }
  });
  const transitionMutation = useMutation({
    mutationFn: ({ item, next }: { item: Item; next: string }) => api(`/items/${item.id}/transition`, token, { method: "POST", body: JSON.stringify({ status: next, version: item.version }) }),
    onSuccess: () => { refresh(); setToast("Workflow updated"); },
  });
  const updateMutation = useMutation({
    mutationFn: ({ item, priority: nextPriority }: { item: Item; priority: string }) => api(`/items/${item.id}`, token, { method: "PATCH", body: JSON.stringify({ version: item.version, priority: nextPriority }) }),
    onSuccess: () => { refresh(); setToast("Priority updated"); },
  });
  const commentMutation = useMutation({
    mutationFn: (item: Item) => api(`/items/${item.id}/comments`, token, { method: "POST", body: JSON.stringify({ body: comment }) }),
    onSuccess: () => { setComment(""); refresh(); setToast("Comment added"); }
  });

  const counts = useMemo(() => ({
    open: summaryQuery.data?.totalOpen ?? 0,
    urgent: summaryQuery.data?.urgentUnassigned ?? 0,
    approval: summaryQuery.data?.awaitingApproval ?? 0,
    overdue: summaryQuery.data?.overdue ?? 0
  }), [summaryQuery.data]);

  if (!token || !user) {
    return <main className="login-shell">
      <div className="login-card">
        <div className="brand-mark"><Activity size={23}/></div>
        <div className="eyebrow">OPERATIONS CONTROL CENTER</div>
        <h1>Make every incident<br/><span>actionable.</span></h1>
        <p className="muted">One clear view of your team's work, urgency, and accountability.</p>
        <form onSubmit={(e) => { e.preventDefault(); loginMutation.mutate(); }} className="login-form">
          <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required/></label>
          <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required/></label>
          {loginError && <div className="error-box">{loginError}</div>}
          <button className="primary-btn full" disabled={loginMutation.isPending}>{loginMutation.isPending ? "Signing in…" : "Sign in"} <span>→</span></button>
        </form>
        <div className="demo-hint"><ShieldCheck size={15}/> Demo: admin@opspulse.local · DemoPass123!</div>
      </div>
      <div className="login-art">
        <div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/>
        <div className="art-content"><div className="live-pill"><span/> LIVE OPERATIONS</div><div className="art-number">24<span>/7</span></div><div className="art-caption">Clarity under pressure.</div>
          <div className="floating-card"><div className="float-icon"><AlertTriangle size={17}/></div><div><b>Settlement delay</b><small>URGENT · Payments</small></div><span className="float-time">2h left</span></div>
          <div className="floating-card second"><div className="float-icon green"><CheckCircle2 size={17}/></div><div><b>Ownership confirmed</b><small>Activity recorded</small></div><span className="float-check">✓</span></div>
        </div>
      </div>
    </main>;
  }

  const signOut = () => { localStorage.removeItem("opspulse-token"); setToken(""); setSelectedId(""); qc.clear(); };
  const actionError = [createMutation.error, claimMutation.error, transitionMutation.error, updateMutation.error, commentMutation.error].find(Boolean) as Error | undefined;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Activity size={20}/></div><span>ops<span>pulse</span></span></div>
      <div className="side-label">WORKSPACE</div>
      <button className={`nav-item ${focus === "all" ? "active" : ""}`} onClick={() => setFocus("all")}><LayoutDashboard size={17}/> Overview</button>
      <button className={`nav-item ${focus === "mine" ? "active" : ""}`} onClick={() => setFocus("mine")}><Users size={17}/> Assigned to me</button>
      <button className={`nav-item ${focus === "unassigned" ? "active" : ""}`} onClick={() => setFocus("unassigned")}><AlertTriangle size={17}/> Unassigned urgent <span className="nav-count">{counts.urgent}</span></button>
      <button className={`nav-item ${focus === "approval" ? "active" : ""}`} onClick={() => setFocus("approval")}><ShieldCheck size={17}/> Awaiting approval <span className="nav-count">{counts.approval}</span></button>
      <div className="side-label team-label">YOUR TEAMS</div>
      {user.memberships.map((m) => <div className="team-line" key={m.teamId}><span className="team-dot"/><span>{m.team.name}</span><small>{label(m.role)}</small></div>)}
      <div className="sidebar-bottom"><div className="avatar">{initials(user.name)}</div><div className="user-meta"><b>{user.name}</b><small>{user.email}</small></div><button title="Sign out" className="icon-button" onClick={signOut}><LogOut size={16}/></button></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div><div className="breadcrumb">Workspace <span>/</span> {focus === "all" ? "Overview" : focus === "mine" ? "Assigned to me" : focus === "unassigned" ? "Unassigned urgent" : "Awaiting approval"}</div><h1>{focus === "all" ? "Operations overview" : focus === "mine" ? "Assigned to me" : focus === "unassigned" ? "Unassigned urgent" : "Awaiting approval"}</h1></div><div className="top-actions"><div className="secure-label"><span/> All systems operational</div><button className="icon-button" title="Refresh data" onClick={refresh}><RefreshCw size={17}/></button><button className="primary-btn" onClick={() => setShowCreate(true)}><Plus size={17}/> New work item</button></div></header>
      <section className="welcome-row"><div><div className="eyebrow">MONDAY · OPERATIONS SNAPSHOT</div><h2>Good work starts with <span>clear priorities.</span></h2><p>Here is what needs your team's attention right now.</p></div><div className="date-chip"><Clock3 size={15}/>{new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</div></section>

      {summaryQuery.isLoading ? <div className="loading-line">Loading operations snapshot…</div> : <section className="stats-grid">
        <Stat icon={<Activity size={18}/>} title="Active work" value={counts.open} detail="Open, in progress, approval" tone="violet"/>
        <Stat icon={<AlertTriangle size={18}/>} title="Urgent & unassigned" value={counts.urgent} detail="Needs an owner now" tone="orange"/>
        <Stat icon={<ShieldCheck size={18}/>} title="Awaiting approval" value={counts.approval} detail="Lead action required" tone="blue"/>
        <Stat icon={<Clock3 size={18}/>} title="Overdue items" value={counts.overdue} detail="Past due date" tone="red"/>
      </section>}

      <section className="work-section">
        <div className="section-heading"><div><h3>Work queue <span className="result-count">{items.length}</span></h3><p>Search and triage work across your teams.</p></div><div className="queue-actions"><button className="secondary-btn" onClick={() => { setSearch(""); setStatus(""); setPriority(""); setFocus("all"); }}><Filter size={15}/> Clear filters</button><button className="secondary-btn" onClick={refresh}><ArrowDownUp size={15}/> Sync</button></div></div>
        <div className="filter-bar"><div className="search-field"><Search size={16}/><input placeholder="Search title or description…" value={search} onChange={(e) => setSearch(e.target.value)}/><kbd>⌘ K</kbd></div><select value={status} onChange={(e) => { setStatus(e.target.value); setFocus("all"); }}><option value="">All statuses</option><option value="OPEN">Open</option><option value="IN_PROGRESS">In progress</option><option value="AWAITING_APPROVAL">Awaiting approval</option><option value="RESOLVED">Resolved</option><option value="CLOSED">Closed</option></select><select value={priority} onChange={(e) => setPriority(e.target.value)}><option value="">All priorities</option><option value="URGENT">Urgent</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></select></div>
        {actionError && <div className="error-box action-error"><AlertTriangle size={16}/>{actionError.message}{(actionError as any).status === 409 && " Reload the item before trying again."}</div>}
        {itemsQuery.isLoading ? <div className="empty-state">Loading work items…</div> : itemsQuery.isError ? <div className="error-box">Could not load work items. Check that the API and database are running.</div> : items.length === 0 ? <div className="empty-state"><CircleHelp size={25}/><b>No matching work items</b><span>Try changing your filters or create a new item.</span></div> : <div className="table-wrap"><table><thead><tr><th>WORK ITEM</th><th>PRIORITY</th><th>STATUS</th><th>OWNER</th><th>TEAM</th><th>DUE</th><th></th></tr></thead><tbody>
          {items.map((item) => <tr key={item.id} onClick={() => setSelectedId(item.id)} className="click-row"><td><div className="item-title"><span className={`type-icon ${item.type.toLowerCase()}`}>{item.type === "PAYMENT" ? "$" : item.type === "INCIDENT" ? "!" : "↗"}</span><div><b>{item.title}</b><small>{item.id.slice(-7).toUpperCase()} · {label(item.type)}</small></div></div></td><td><span className={`priority ${item.priority.toLowerCase()}`}><i/>{label(item.priority)}</span></td><td><span className={`status ${item.status.toLowerCase()}`}>{label(item.status)}</span></td><td>{item.assignee ? <span className="owner"><span className="mini-avatar">{initials(item.assignee.name)}</span>{item.assignee.name}</span> : <span className="unassigned">Unassigned</span>}</td><td><span className="team-name">{item.team.name}</span></td><td><DueDate value={item.dueDate} status={item.status}/></td><td><button className="row-more" onClick={(e) => { e.stopPropagation(); setSelectedId(item.id); }}><ChevronDown size={16}/></button></td></tr>)}
        </tbody></table></div>}
        <div className="table-footer"><span>Showing {items.length} items · Server-side filters</span><span className="footer-note"><ShieldCheck size={14}/> Team access enforced by API</span></div>
      </section>
      <footer className="app-footer"><span>OPSPULSE <b>·</b> OPERATIONS INTELLIGENCE</span><span><span className="footer-dot"/> Connected to API</span></footer>
    </main>

    {selectedId && <div className="drawer-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelectedId(""); }}><aside className="detail-drawer">
      <div className="drawer-head"><span className="eyebrow">WORK ITEM DETAILS</span><button className="icon-button" onClick={() => setSelectedId("")}><X size={19}/></button></div>
      {detailQuery.isLoading ? <div className="empty-state">Loading item…</div> : selected ? <>
        <div className="detail-type">{label(selected.type)} <span>·</span> {selected.id.slice(-8).toUpperCase()}</div><h2>{selected.title}</h2><p className="detail-description">{selected.description || "No description provided."}</p>
        <div className="detail-badges"><span className={`priority ${selected.priority.toLowerCase()}`}><i/>{label(selected.priority)}</span><span className={`status ${selected.status.toLowerCase()}`}>{label(selected.status)}</span></div>
        <div className="detail-grid"><div><small>TEAM</small><b>{selected.team.name}</b></div><div><small>ASSIGNEE</small><b>{selected.assignee?.name || "Unassigned"}</b></div><div><small>CREATED BY</small><b>{selected.createdBy.name}</b></div><div><small>VERSION</small><b>v{selected.version}</b></div></div>
        {canEdit && <div className="detail-actions">
          {!selected.assigneeId && <button className="primary-btn full" onClick={() => claimMutation.mutate(selected.id)} disabled={claimMutation.isPending}><Users size={16}/> Claim this item</button>}
          <label className="select-label">Change priority<select value={selected.priority} onChange={(e) => updateMutation.mutate({ item: selected, priority: e.target.value })}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="URGENT">Urgent</option></select></label>
          <div className="workflow-buttons">
            {selected.status === "OPEN" && <button className="secondary-btn" onClick={() => transitionMutation.mutate({ item: selected, next: "IN_PROGRESS" })}>Start work</button>}
            {selected.status === "IN_PROGRESS" && <button className="secondary-btn" onClick={() => transitionMutation.mutate({ item: selected, next: "AWAITING_APPROVAL" })}>Request approval</button>}
            {selected.status === "AWAITING_APPROVAL" && <button className="secondary-btn" onClick={() => transitionMutation.mutate({ item: selected, next: "IN_PROGRESS" })}>Return to work</button>}
            {selected.status === "AWAITING_APPROVAL" && canLead && <button className="primary-btn" onClick={() => transitionMutation.mutate({ item: selected, next: "RESOLVED" })}>Approve & resolve</button>}
            {selected.status === "RESOLVED" && <button className="secondary-btn" onClick={() => transitionMutation.mutate({ item: selected, next: "CLOSED" })}>Close item</button>}
            {selected.status === "RESOLVED" && <button className="secondary-btn" onClick={() => transitionMutation.mutate({ item: selected, next: "IN_PROGRESS" })}>Reopen</button>}
          </div>
        </div>}
        <div className="timeline-section"><h3><Activity size={16}/> Activity timeline</h3>{(selected.events || []).length ? <div className="timeline">{selected.events?.map((event: any) => <div className="timeline-event" key={event.id}><span className="timeline-dot"/><div><b>{event.actor.name}</b> <span>{event.action.toLowerCase().replaceAll("_", " ")}</span>{event.field && <p>{label(event.field)}: {event.oldValue || "—"} → {event.newValue || "—"}</p>}{event.details && <p>{event.details}</p>}<small>{new Date(event.createdAt).toLocaleString()}</small></div></div>)}</div> : <p className="muted small">No activity recorded yet.</p>}</div>
        <div className="comments-section"><h3>Comments <span>{selected.comments?.length || 0}</span></h3><div className="comment-list">{selected.comments?.map((c: any) => <div className="comment" key={c.id}><span className="mini-avatar">{initials(c.author.name)}</span><div><b>{c.author.name}</b><small>{new Date(c.createdAt).toLocaleString()}</small><p>{c.body}</p></div></div>)}</div><form className="comment-form" onSubmit={(e) => { e.preventDefault(); commentMutation.mutate(selected); }}><input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment…" maxLength={2000}/><button className="primary-btn" disabled={!comment.trim() || commentMutation.isPending}><Plus size={15}/></button></form></div>
      </> : <div className="error-box">Could not load this item.</div>}
    </aside></div>}

    {showCreate && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowCreate(false); }}><div className="create-modal"><div className="modal-head"><div><span className="eyebrow">NEW WORK ITEM</span><h2>Capture the work.</h2></div><button className="icon-button" onClick={() => setShowCreate(false)}><X size={19}/></button></div><form onSubmit={(e) => { e.preventDefault(); createMutation.mutate(); }} className="create-form">
      <label>Title<input required minLength={3} maxLength={160} placeholder="e.g. Payment settlement delayed" value={createForm.title} onChange={(e) => setCreateForm({ ...createForm, title: e.target.value })}/></label>
      <label>Description<textarea rows={3} placeholder="What happened, who is affected, and what is known?" value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}/></label>
      <div className="form-two"><label>Type<select value={createForm.type} onChange={(e) => setCreateForm({ ...createForm, type: e.target.value })}><option value="INCIDENT">Incident</option><option value="CUSTOMER_ISSUE">Customer issue</option><option value="PAYMENT">Payment</option><option value="COMPLIANCE">Compliance</option><option value="TASK">Task</option></select></label><label>Priority<select value={createForm.priority} onChange={(e) => setCreateForm({ ...createForm, priority: e.target.value })}><option value="URGENT">Urgent</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option></select></label></div>
      <div className="form-two"><label>Team<select value={createForm.teamId} onChange={(e) => setCreateForm({ ...createForm, teamId: e.target.value })}>{user.memberships.map((m) => <option value={m.teamId} key={m.teamId}>{m.team.name}</option>)}</select></label><label>Due date<input type="datetime-local" value={createForm.dueDate} onChange={(e) => setCreateForm({ ...createForm, dueDate: e.target.value })}/></label></div>
      {createMutation.error && <div className="error-box">{(createMutation.error as Error).message}</div>}
      <div className="modal-footer"><button type="button" className="secondary-btn" onClick={() => setShowCreate(false)}>Cancel</button><button className="primary-btn" disabled={createMutation.isPending}>{createMutation.isPending ? "Creating…" : "Create work item"} <span>→</span></button></div>
    </form></div></div>}
    {toast && <div className="toast"><CheckCircle2 size={17}/>{toast}<button onClick={() => setToast("")}><X size={14}/></button></div>}
  </div>;
}

function Stat({ icon, title, value, detail, tone }: { icon: React.ReactNode; title: string; value: number; detail: string; tone: string }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div className="stat-label">{title}</div><div className="stat-value">{value}</div><div className="stat-detail">{detail}</div></div>;
}
function DueDate({ value, status }: { value: string | null; status: string }) {
  if (!value) return <span className="due-none">—</span>;
  const date = new Date(value); const overdue = date.getTime() < Date.now() && !["RESOLVED", "CLOSED"].includes(status);
  return <span className={`due-date ${overdue ? "overdue" : ""}`}>{overdue && <AlertTriangle size={12}/>} {date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>;
}
