import { ChangeDetectionStrategy, Component, signal, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

type View = 'entry' | 'owner-login' | 'create' | 'group' | 'review' | 'report' | 'manage' | 'register';
type Question = { id: string; prompt: string; scale: 'frequency' | 'extent' };
type Category<T = Question> = { id: string; title: string; items: T[] };
type Friend = { id: string; name: string; done: number };
type Group = { id: string; name: string; open: boolean; deadline: number };
type GroupPage = Group & { me: string; consent: string[]; canChangeConsent: boolean; friends: Friend[] };
type Form = { name: string; categories: Category[]; text: boolean };
type Report = { analysis?: string | null; analysisAvailable?: boolean; name: string; report: Category<Question & { score: number | null; count: number | null }>[]; comments: Record<string, string[]> };
type ManagedGroup = Group & { members: (Pick<Friend, 'id' | 'name'> & {approved:boolean})[] };

@Component({
  selector: 'derang-app',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
})
class App {
  readonly view = signal<View>('entry');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly group = signal<GroupPage | null>(null);
  readonly form = signal<Form | null>(null);
  readonly report = signal<Report | null>(null);
  readonly managed = signal<ManagedGroup | null>(null);
  readonly categories = signal<{id: string; title: string}[]>([]);
  readonly groupKey = signal(sessionStorage.getItem('derang-group-key') ?? '');
  readonly ownerKey = signal('');
  readonly answers = signal<Record<string, number>>({});
  readonly step = signal(0);
  readonly consent = signal<string[]>([]);
  readonly extras = signal<string[]>([]);
  readonly invite = signal('');
  readonly registrationKey = signal('');
  readonly registered = signal(false);
  private readonly inviteParams = new URLSearchParams(location.hash.slice(1));
  readonly invitedGroup = this.inviteParams.get('group') ?? '';
  private readonly invitation = this.inviteParams.get('invite') ?? '';
  readonly configured = signal<boolean | null>(null);
  readonly options = ['style','politics','text'];
  readonly optionLabels = ['ظاهر و زبان بدن','گفت‌وگوهای سیاسی','بازخورد نوشتاری'];
  readonly labels = {
    extent: ['خیلی کم','کم','متوسط','زیاد','خیلی زیاد'],
    frequency: ['هرگز','به‌ندرت','گاهی','اغلب','تقریباً همیشه'],
  };
  readonly format = new Intl.NumberFormat('fa-IR');
  readonly dates = new Intl.DateTimeFormat('fa-IR', {dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Tehran'});
  appreciation = '';
  change = '';
  private apiBase = '';
  private token = sessionStorage.getItem('derang-group-session') ?? '';
  private target = '';
  private readonly init = fetch(new URL('config.json', document.baseURI), {cache:'no-store'})
    .then(response => response.json())
    .then((config: { apiBase?: string }) => {
      this.apiBase = config.apiBase?.replace(/\/$/, '') ?? '';
      this.configured.set(!!this.apiBase);
    })
    .catch(() => this.configured.set(false));

  constructor() {
    if (this.invitation) {
      this.view.set('register');
      return;
    }
    if (this.token) void this.task(async () => {
      if (sessionStorage.getItem('derang-group-role') === 'owner') await this.openManage();
      else await this.openGroup();
    });
  }

  private async request<T>(path: string, body?: object): Promise<T> {
    await this.init;
    if (!this.apiBase) throw new Error('اتصال سرور هنوز تنظیم نشده است.');
    const response = await fetch(this.apiBase + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : {'Content-Type':'application/json'}), ...(this.token ? {Authorization:'Bearer ' + this.token} : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 && this.view() !== 'register' && !path.startsWith('/access/')) this.clear();
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.message ?? 'سرور در دسترس نیست.');
    return result as T;
  }

  private async task(action: () => Promise<void>) {
    if (this.busy()) return;
    this.error.set('');
    this.notice.set('');
    this.busy.set(true);
    try { await action(); }
    catch (error) { this.error.set(error instanceof TypeError ? 'ارتباط با سرور برقرار نشد.' : (error as Error).message); }
    finally { this.busy.set(false); }
  }

  show(view: View) {
    this.error.set('');
    this.notice.set('');
    this.view.set(view);
  }
  login(event: Event, type: 'member' | 'owner') {
    event.preventDefault();
    const fields = new FormData(event.target as HTMLFormElement);
    void this.task(async () => {
      const result = await this.request<{token:string}>('/access/' + type, Object.fromEntries(fields));
      this.setSession(result.token, type, String(fields.get('groupKey')).replace(/[\s-]/g, '').toUpperCase());
      if (type === 'owner') await this.openManage();
      else await this.openGroup();
    });
  }
  private setSession(token: string, role: 'member' | 'owner', groupKey: string) {
    this.token = token;
    this.groupKey.set(groupKey);
    sessionStorage.setItem('derang-group-session', token);
    sessionStorage.setItem('derang-group-role', role);
    sessionStorage.setItem('derang-group-key', groupKey);
  }
  openCreate() {
    void this.task(async () => {
      this.categories.set(await this.request<{id:string;title:string}[]>('/categories'));
      this.show('create');
    });
  }
  private clear() {
    this.token = '';
    sessionStorage.removeItem('derang-group-session');
    sessionStorage.removeItem('derang-group-role');
    this.group.set(null);
    this.managed.set(null);
    this.extras.set([]);
    this.ownerKey.set('');
    this.groupKey.set('');
    sessionStorage.removeItem('derang-group-key');
    this.report.set(null);
    this.form.set(null);
    this.invite.set('');
    this.answers.set({});
    this.show('entry');
  }
  logout() { void this.task(async () => { try { await this.request('/logout', {}); } finally { this.clear(); } }); }

  private async openGroup() {
    const group = await this.request<GroupPage>('/group');
    this.group.set(group);
    this.consent.set(group.consent);
    this.show('group');
  }
  backToGroup() { void this.task(() => this.openGroup()); }
  private async openManage() {
    this.managed.set(await this.request<ManagedGroup>('/manage'));
    this.show('manage');
  }
  refreshManage() { void this.task(() => this.openManage()); }
  toggle(list: 'extras' | 'consent', id: string, selected: boolean) {
    this[list].update(value => selected ? [...new Set([...value,id])] : value.filter(entry => entry !== id));
  }
  saveConsent() {
    void this.task(async () => {
      await this.request('/consent', {options: this.consent()});
      await this.openGroup();
      this.notice.set('ترجیحاتت ذخیره شد.');
    });
  }
  startReview(id: string) {
    void this.task(async () => {
      this.form.set(await this.request<Form>('/review/' + id));
      this.target = id;
      this.step.set(0);
      this.answers.set({});
      this.appreciation = '';
      this.change = '';
      this.show('review');
    });
  }
  rate(id: string, score: number) { this.answers.update(answers => ({...answers, [id]: score})); }
  move(step: number) { this.step.set(step); document.getElementById('review-title')?.focus(); }
  submitReview() {
    void this.task(async () => {
      const answers = Object.fromEntries(Object.entries(this.answers()).filter(([,score]) => score > 0));
      await this.request('/review/' + this.target, {answers, appreciation:this.appreciation, change:this.change});
      await this.openGroup();
      this.notice.set('بازخوردت ثبت شد.');
    });
  }
  openReport() {
    void this.task(async () => { this.report.set(await this.request<Report>('/report')); this.show('report'); });
  }
  generateAnalysis() {
    void this.task(async () => {
      const {summary} = await this.request<{summary:string}>('/report/analysis', {});
      this.report.update(report => report ? {...report, analysis:summary} : report);
    });
  }

  createGroup(event: Event) {
    event.preventDefault();
    const fields = new FormData(event.target as HTMLFormElement);
    const deadline = Date.parse(String(fields.get('deadline')));
    void this.task(async () => {
      const result = await this.request<{token:string;groupKey:string;ownerKey:string}>('/groups',
        {name:fields.get('name'), deadline, categories:this.extras()});
      this.setSession(result.token, 'owner', result.groupKey);
      this.ownerKey.set(result.ownerKey);
      this.extras.set([]);
      this.show('manage');
      await this.openManage();
    });
  }
  leaveRegistration() {
    history.replaceState(null, '', location.pathname + location.search);
    this.registrationKey.set('');
    this.registered.set(false);
    if (sessionStorage.getItem('derang-group-role') === 'owner' && this.token) this.refreshManage();
    else if (this.token) this.backToGroup();
    else this.show('entry');
  }
  register(event: Event) {
    event.preventDefault();
    const name = new FormData(event.target as HTMLFormElement).get('name');
    void this.task(async () => {
      const key = this.registrationKey() || Array.from(crypto.getRandomValues(new Uint8Array(16)),
        byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
      this.registrationKey.set(key);
      await this.request('/register', {name, groupKey:this.invitedGroup, invite:this.invitation, key});
      this.registered.set(true);
    });
  }
  createInvite() {
    void this.task(async () => {
      const {invite} = await this.request<{invite:string}>('/manage/invites', {});
      const url = new URL(document.baseURI);
      url.hash = new URLSearchParams({group:this.groupKey(),invite}).toString();
      this.invite.set(url.href);
    });
  }
  approveMember(id: string) {
    void this.task(async () => {
      await this.request('/manage/members/' + id + '/approve', {});
      await this.openManage();
      this.notice.set('عضویت تأیید شد.');
    });
  }
  copyKey(key: string) {
    void this.task(async () => { await navigator.clipboard.writeText(key); this.notice.set('کلید کپی شد.'); });
  }
  closeGroup() {
    if (!confirm('دوره بسته شود و گزارش‌ها منتشر شوند؟')) return;
    void this.task(async () => { await this.request('/manage/close', {}); await this.openManage(); });
  }
}
bootstrapApplication(App, {providers:[provideZonelessChangeDetection()]}).catch(console.error);
