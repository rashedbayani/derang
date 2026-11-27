import { ChangeDetectionStrategy, Component, signal, provideZonelessChangeDetection } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';

type View = 'entry' | 'admin-login' | 'group' | 'review' | 'report' | 'admin';
type Question = { id: string; prompt: string; scale: 'frequency' | 'extent' };
type Category<T = Question> = { id: string; title: string; items: T[] };
type Friend = { id: string; name: string; done: number };
type Group = { id: string; name: string; open: boolean; deadline: number };
type GroupPage = Group & { me: string; consent: string[]; canChangeConsent: boolean; friends: Friend[] };
type Form = { name: string; categories: Category[]; text: boolean };
type Report = { name: string; report: Category<Question & { score: number | null; count: number | null }>[]; comments: Record<string, string[]> };
type Admin = { categories: { id: string; title: string }[]; groups: (Group & { members: Friend[] })[] };

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
  readonly admin = signal<Admin | null>(null);
  readonly answers = signal<Record<string, number>>({});
  readonly step = signal(0);
  readonly consent = signal<string[]>([]);
  readonly extras = signal<string[]>([]);
  readonly invite = signal('');
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
  private token = sessionStorage.getItem('derang-session') ?? '';
  private target = '';
  private readonly init = fetch(new URL('config.json', document.baseURI), {cache:'no-store'})
    .then(response => response.json())
    .then((config: { apiBase?: string }) => {
      this.apiBase = config.apiBase?.replace(/\/$/, '') ?? '';
      this.configured.set(!!this.apiBase);
    })
    .catch(() => this.configured.set(false));

  constructor() {
    if (this.token) void this.task(async () => {
      if (sessionStorage.getItem('derang-role') === 'admin') await this.openAdmin();
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
    if (response.status === 401 && !path.startsWith('/access/')) this.clear();
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
  login(event: Event, type: 'member' | 'admin') {
    event.preventDefault();
    const fields = new FormData(event.target as HTMLFormElement);
    void this.task(async () => {
      const result = await this.request<{token:string;role:string}>('/access/' + type, Object.fromEntries(fields));
      this.token = result.token;
      sessionStorage.setItem('derang-session', result.token);
      sessionStorage.setItem('derang-role', result.role);
      if (type === 'admin') await this.openAdmin();
      else await this.openGroup();
    });
  }
  private clear() {
    this.token = '';
    sessionStorage.removeItem('derang-session');
    sessionStorage.removeItem('derang-role');
    this.group.set(null);
    this.admin.set(null);
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
  private async openAdmin() {
    this.admin.set(await this.request<Admin>('/admin'));
    this.show('admin');
  }
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
  createGroup(event: Event) {
    event.preventDefault();
    const fields = new FormData(event.target as HTMLFormElement);
    const deadline = Date.parse(String(fields.get('deadline')));
    void this.task(async () => {
      await this.request('/groups', {name:fields.get('name'), deadline, categories:this.extras()});
      this.extras.set([]);
      (event.target as HTMLFormElement).reset();
      await this.openAdmin();
      this.notice.set('گروه ساخته شد.');
    });
  }
  addMember(event: Event, id: string) {
    event.preventDefault();
    const name = new FormData(event.target as HTMLFormElement).get('name');
    void this.task(async () => {
      const result = await this.request<{code:string}>('/groups/' + id + '/members', {name});
      this.invite.set(result.code);
      (event.target as HTMLFormElement).reset();
      await this.openAdmin();
    });
  }
  copyInvite() {
    void this.task(async () => { await navigator.clipboard.writeText(this.invite()); this.notice.set('کد کپی شد.'); });
  }
  closeGroup(id: string) {
    if (!confirm('دوره بسته شود و گزارش‌ها منتشر شوند؟')) return;
    void this.task(async () => { await this.request('/groups/' + id + '/close', {}); await this.openAdmin(); });
  }
}
bootstrapApplication(App, {providers:[provideZonelessChangeDetection()]}).catch(console.error);
