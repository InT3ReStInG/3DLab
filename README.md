# Printers Lab 750

3B yazıcıların durumunu, baskı sırasını, planlı işleri, rezervasyonları, bakım/arızaları ve işlem geçmişini ortak bir takvim üzerinden yönetmek için geliştirilmiş web uygulamasıdır.

Bu belge uygulamanın teknik yapısını, mevcut Cloudflare kurulumunu, TUSAŞ'a devrini ve kurum içi sunucuya taşıma seçeneklerini açıklar.

> **Önemli:** Bu proje şu anda bir prototip/pilot uygulamadır. Kurumsal üretim ortamına alınmadan önce TUSAŞ BT ve Bilgi Güvenliği ekiplerinin güvenlik, kimlik doğrulama, yedekleme, loglama ve ağ erişimi incelemesinden geçirilmelidir.

## İçindekiler

- [Özellikler](#özellikler)
- [Teknik mimari](#teknik-mimari)
- [Klasör yapısı](#klasör-yapısı)
- [API yapısı](#api-yapısı)
- [Veritabanı yapısı](#veritabanı-yapısı)
- [Kimlik doğrulama ve yetki](#kimlik-doğrulama-ve-yetki)
- [Senaryo 1: TUSAŞ Cloudflare hesabına temiz kurulum](#senaryo-1-tusaş-cloudflare-hesabına-temiz-kurulum)
- [Senaryo 2: TUSAŞ Cloudflare hesabına mevcut verilerle taşıma](#senaryo-2-tusaş-cloudflare-hesabına-mevcut-verilerle-taşıma)
- [Senaryo 3: TUSAŞ kurum içi sunucusuna taşıma](#senaryo-3-tusaş-kurum-içi-sunucusuna-taşıma)
- [Devir teslim kontrol listesi](#devir-teslim-kontrol-listesi)
- [İşletim ve bakım](#işletim-ve-bakım)

## Özellikler

- Yazıcı ekleme, silme, yeniden adlandırma ve renklendirme
- Uygun, baskıda, tamamlandı, bakımda ve arızalı durumları
- Anlık baskı başlatma, iptal etme ve tamamlama
- Baskı sırası, planlı baskı ve rezervasyon yönetimi
- Planlı baskıları takvimde başka saate veya yazıcıya sürükleme
- Devam eden/planlı baskılarda gecikme, gerçek ilerleme yüzdesi ve erken başlangıç düzeltmesi
- 08:00–17:00 iş başlangıç saatleri ile hafta sonlarını dikkate alan otomatik planlama
- Kayıtlı işler ve planlanan/basılmakta olan iş göstergeleri
- Üç geçmiş günle başlayan 31 günlük takvim, yakınlaştırma ve günlük gezinme
- Yazıcı bazında baskı sayısı, çalışma saati, ortalama süre ve kullanım istatistikleri
- Baskı ve işlem geçmişi
- Kullanıcı kaydı, giriş, çıkış ve “beni hatırla”
- Yeni kullanıcılar için değişiklik yetkisi onayı
- Kullanıcı hesabına özel yazıcı sıralaması
- Giriş yapmamış kullanıcılar için salt okunur görünüm

## Teknik mimari

Uygulama üç ana katmandan oluşur:

1. **Arayüz:** `public/` içindeki HTML, CSS ve saf JavaScript dosyalarıdır. Frontend derleme adımı veya framework yoktur.
2. **Sunucu API'si:** Cloudflare Pages Functions/Workers ortamında çalışan JavaScript kodudur. `/api/auth` ve `/api/state` isteklerini işler.
3. **Veritabanı:** Cloudflare D1 kullanır. Uygulama veritabanına `DB` adlı binding üzerinden erişir.

```text
Tarayıcı
  ├── public/index.html, app.js, styles.css
  ├── /api/auth  ──► kayıt, giriş, çıkış ve oturum
  └── /api/state ──► yazıcılar, takvim, kayıtlı işler ve geçmiş
                         │
                         └── DB binding ──► Cloudflare D1
```

Arayüz yaklaşık her 30 saniyede bir `/api/state` çağrısı yapar. Planlı baskıların otomatik başlatılması ve tamamlanan durumların işlenmesi ayrı bir arka plan servisiyle değil, bir sonraki API isteği sırasında gerçekleşir. Hiç kimse uygulamayı açmıyorsa geçiş tam saniyesinde çalışmayabilir; sonraki istek geldiğinde işlenir.

## Klasör yapısı

```text
3DLab/
├── functions/
│   └── api/
│       ├── auth.js       # Pages Functions için /api/auth giriş noktası
│       └── state.js      # API, auth, iş kuralları ve D1 işlemleri
├── public/
│   ├── _routes.json      # Pages Functions yönlendirme ayarı
│   ├── app.js            # Arayüz davranışı ve API çağrıları
│   ├── index.html        # Ana sayfa ve diyalog yapıları
│   └── styles.css        # Görsel tasarım ve mobil uyumluluk
├── worker.js             # Worker dağıtımında API/statik dosya yönlendiricisi
├── wrangler.toml         # Worker, asset ve D1 binding ayarları
└── README.md             # Teknik devir belgesi
```

| Dosya | Görevi |
| --- | --- |
| `public/app.js` | Takvim, yazıcı kartları, formlar, sürükle-bırak, oturum token fallback'i ve otomatik yenileme |
| `functions/api/state.js` | Tablolar, auth, yetkilendirme, iş kuralları ve bütün D1 işlemleri |
| `functions/api/auth.js` | Pages Functions auth isteğini ana API koduna aktarır |
| `worker.js` | Worker kullanımında `/api/*` isteklerini API'ye, diğerlerini statik dosyalara yönlendirir |
| `wrangler.toml` | Proje adı, entrypoint, statik asset dizini ve `DB` bağlantısı |

## API yapısı

### `GET /api/state`

Güncel durumu ve varsa giriş yapmış kullanıcıyı döndürür:

- `printers`: yazıcılar, aktif işler, sıralar, rezervasyonlar ve baskı geçmişleri
- `activity`: genel işlem geçmişi
- `savedJobs`: kayıtlı işler
- `user`: kullanıcının herkese açık bilgileri ve kişisel yazıcı sırası

### `POST /api/state`

Yazıcı, iş, rezervasyon, bakım ve takvim değişikliklerini gerçekleştirir.

- Kullanıcı girişi zorunludur.
- Ortak veri değişiklikleri için `can_edit = 1` gerekir.
- `reorderPrinters` kişisel ayardır; onay bekleyen kullanıcılar da kullanabilir.
- Sunucu işlem yapan kişinin adını oturumdan alır.
- `adjustPrintTiming`, gecikmeyi takip eden sıkışık planlara aktarır; 30 dakikadan büyük boşluklar gecikmeyi önce kendi içinde emer.
- `autoSchedulePrints`, seçilen işleri sıra, mevcut planlar, 08:00–17:00 başlangıç aralığı ve hafta sonlarına göre yerleştirir.

### `GET /api/auth`

Mevcut oturumu ve kullanıcı bilgisini döndürür.

### `POST /api/auth`

`mode` alanına göre `register`, `login` veya `logout` işlemini yapar.

Kurum içi sisteme taşınırken arayüzün büyük ölçüde değişmeden kalması için yeni backend'in aynı URL'leri ve JSON cevap biçimlerini koruması önerilir.

## Veritabanı yapısı

Uygulama ilk istekte gerekli tabloları otomatik oluşturur.

### `users`

| Alan | Açıklama |
| --- | --- |
| `id` | Kullanıcı UUID'si |
| `name` | Görünen kullanıcı adı |
| `name_key` | Büyük/küçük harf duyarsız giriş anahtarı |
| `password_hash` | Parola hash değeri |
| `salt` | Kullanıcıya özel salt |
| `can_edit` | `0`: salt okunur, `1`: değişiklik yapabilir |
| `printer_order` | Kişisel yazıcı sırası, JSON dizisi |
| `created_at` | Oluşturma zamanı, Unix epoch milisaniye |

### `sessions`

| Alan | Açıklama |
| --- | --- |
| `token_hash` | Oturum token'ının SHA-256 hash değeri |
| `user_id` | Bağlı kullanıcı |
| `expires_at` | Oturum bitiş zamanı |
| `created_at` | Oturum oluşturma zamanı |

### `lab_state`

Ortak durum tek satırda (`id = 1`) tutulur.

| Alan | Açıklama |
| --- | --- |
| `printers` | Yazıcılar ve alt verileri içeren JSON |
| `activity` | Genel işlem kayıtlarını içeren JSON |
| `saved_jobs` | Kayıtlı işleri içeren JSON |
| `updated_at` | Son değişiklik zamanı |

Bu yapı küçük laboratuvar kullanımı için basittir. Çok sayıda eşzamanlı kullanıcı veya birden fazla sunucu örneğinde verilerin ilişkisel tablolara bölünmesi, transaction/locking uygulanması ve kayıp güncellemelerin engellenmesi gerekir.

## Kimlik doğrulama ve yetki

- Parolalar salt ile PBKDF2-SHA256 kullanılarak hashlenir.
- Açık parola tutulmaz.
- Oturum token'ları veritabanında yalnızca SHA-256 hash olarak tutulur.
- Ana oturum `HttpOnly; Secure; SameSite=Lax` cookie ile gönderilir.
- Kurumsal tarayıcının cookie'yi engellemesine karşı istemcide opaque token fallback'i vardır.
- “Beni hatırla” seçilirse süre 30 gün, seçilmezse sunucu oturumu 12 saattir.
- Yeni kullanıcı `can_edit = 0` ile oluşturulur; giriş yapabilir fakat ortak veriyi değiştiremez.

D1 **Explore Data → users** ekranından `can_edit` değiştirilebilir. SQL örnekleri:

```sql
UPDATE users SET can_edit = 1 WHERE name = 'Kullanıcı Adı';
UPDATE users SET can_edit = 0 WHERE name = 'Kullanıcı Adı';
```

### Kurumsal güvenlik önerisi

Mevcut hesap sistemi pilot kullanım içindir. Üretimde mümkünse TUSAŞ'ın onaylı SSO/Active Directory/LDAP çözümü kullanılmalıdır. Kurum içine geçişte mevcut oturumlar taşınmamalıdır. Özel parola sistemi korunacaksa parola politikası, rate limiting, hesap kilitleme, audit log ve kurumun onayladığı hash parametreleri eklenmelidir.

## Hangi senaryo seçilmeli?

| İhtiyaç | Öneri |
| --- | --- |
| Eski test verileri ve hesaplar gerekmiyor | Senaryo 1: temiz Cloudflare kurulumu |
| Mevcut yazıcılar, geçmiş ve kullanıcılar korunacak | Senaryo 2: verilerle Cloudflare taşıması |
| Dış bulut yasak veya her şey kurum ağında kalmalı | Senaryo 3: kurum içi sunucu |

## Senaryo 1: TUSAŞ Cloudflare hesabına temiz kurulum

**En kolay seçenek budur.** Eski SQL veya JSON verisini aktarmaya gerek yoktur. Yeni D1 veritabanı boş bırakılır; uygulama tabloları ilk açılışta kendisi oluşturur.

### 1. Kurumsal sahiplik

- Cloudflare hesabı TUSAŞ tarafından açılmış ve yönetilen hesap olmalıdır.
- Kod deposu TUSAŞ kontrolünde olmalıdır.
- En az iki yetkili çalışanda yönetim/kurtarma erişimi bulunmalıdır.
- Üretim sistemi stajyerin veya tek çalışanın kişisel hesabına bağlı olmamalıdır.

### 2. Kaynak kodu

Deponun tamamını kurum deposuna kopyalayın. `public`, `functions`, `worker.js`, `wrangler.toml` ve `README.md` kök dizinde kalmalıdır.

### 3. Boş D1 oluşturma

Cloudflare'da **Storage & Databases → D1 SQL Database → Create database** yolundan örneğin `printers-lab-750-db` adlı boş veritabanı oluşturun. Manuel tablo oluşturmayın ve eski veri import etmeyin.

### 4. Pages ile yayınlama

Git entegrasyonunda:

- Production branch: `main`
- Framework preset: `None`
- Build command: boş
- Build output directory: `public`
- Root directory: depo kökü

Proje ayarlarından D1 binding ekleyin:

- Variable name: `DB`
- Database: yeni D1

Binding sonrasında yeniden deployment yapın.

Worker + Static Assets kullanılacaksa `wrangler.toml` içindeki `name`, `database_name` ve `database_id` değerlerini yeni kurumsal kaynaklara göre değiştirin ve kurumsal ortamdan Wrangler ile deploy edin.

### 5. İlk açılış

İlk `/api/state` isteğinde tablolar ve örnek başlangıç yazıcıları oluşur. Ardından:

1. Örnek yazıcıları düzenleyin veya silin.
2. İlk sorumlu kullanıcıyı kaydedin.
3. D1 **Explore Data → users** ekranından `can_edit` değerini `1` yapın.
4. Bir test baskısı oluşturup sayfa yenilendiğinde korunduğunu doğrulayın.

> Tamamen boş laboratuvar isteniyorsa, production devrinden önce `ensureTable` içindeki örnek seed yazıcılar koddan kaldırılmalıdır.

## Senaryo 2: TUSAŞ Cloudflare hesabına mevcut verilerle taşıma

Kaynak koduyla birlikte D1 veritabanı SQL olarak taşınır. Yalnızca JSON vermek önerilmez; SQL export şemayı, kullanıcıları ve durumu birlikte korur.

### 1. Eski D1'i dışa aktarma

```bash
npx wrangler d1 export ESKI_VERITABANI_ADI --remote --output=printers-lab-750-backup.sql
```

Kritik tablolar: `users`, `sessions`, `lab_state`.

JSON yalnızca ek, okunabilir yedek olabilir. `lab_state` alanları zaten JSON metni içerdiği için elle hazırlanan JSON'u doğrudan import etmek güvenilir değildir.

### 2. Oturumları taşımama

Import sonrasında bütün eski oturumları silin:

```sql
DELETE FROM sessions;
```

Kullanıcılar tekrar giriş yapar. Hash algoritması korunursa mevcut parolalar çalışabilir. SSO'ya geçiliyorsa eski hashler yeni kimlik sistemi olarak kullanılmamalıdır.

### 3. Yeni D1 oluşturma ve import

TUSAŞ hesabında boş bir D1 oluşturun. Site kullanıcı erişimine açılmadan önce:

```bash
npx wrangler d1 execute YENI_VERITABANI_ADI --remote --file=printers-lab-750-backup.sql
npx wrangler d1 execute YENI_VERITABANI_ADI --remote --command="DELETE FROM sessions;"
```

### 4. Bağlama ve doğrulama

1. Yeni D1'i uygulamaya tam olarak `DB` adıyla bağlayın.
2. Yeniden deployment yapın.
3. `lab_state` tablosunda `id = 1` satırını kontrol edin.
4. Yazıcı, kayıtlı iş, kullanıcı ve geçmiş sayılarını karşılaştırın.
5. Kullanıcıların tekrar giriş yapmasını isteyin.
6. Test değişikliği yapıp kalıcılığı doğrulayın.

Eski deployment hemen silinmemeli; yeni sistem kabul testini geçene kadar eski sistem ve SQL yedeği güvenli şekilde saklanmalıdır.

## Senaryo 3: TUSAŞ kurum içi sunucusuna taşıma

Cloudflare yasaksa uygulama kurum içi sunucuya taşınabilir. Ancak D1 binding'i ve Pages/Workers runtime'ı iç sunucuda doğrudan çalışmaz; backend uyarlaması gerekir.

### Değişmeden kullanılabilecek bölüm

`public/` standart statik HTML/CSS/JavaScript'tir. Kurum içi web sunucusunda yayınlanabilir. Yeni backend aynı `/api/auth` ve `/api/state` sözleşmesini korursa frontend'de az değişiklik gerekir.

### Yeniden uygulanacak bölüm

- `env.DB.prepare(...).bind(...).run()/first()` D1 çağrıları
- Cloudflare request/response adaptörü
- Cookie ve oturum yönetimi
- D1 yerine kurum veritabanı bağlantısı
- Deployment, TLS, loglama, izleme ve yedekleme

### En basit kurum içi seçenek

Küçük, tek sunuculu kullanım için:

- Node.js backend (Express/Fastify veya onaylı eşdeğer)
- SQLite
- Nginx/IIS reverse proxy
- Kurum içi HTTPS sertifikası

D1, SQLite SQL semantiğine yakın olduğu için temiz başlangıçta SQLite en az dönüşüm gerektiren seçenektir.

### Kurumsal/ölçeklenebilir seçenek

- Kurumun onayladığı .NET, Java, Node.js veya Python backend
- PostgreSQL veya Microsoft SQL Server
- TUSAŞ SSO/Active Directory/LDAP
- Merkezi audit log ve izleme
- Transaction, optimistic locking veya row-level locking
- Düzenli yedekleme ve geri dönüş testi

Bu durumda `lab_state` içindeki JSON'un `printers`, `print_jobs`, `reservations`, `saved_jobs`, `print_history`, `activity_logs` ve `user_printer_order` gibi tablolara bölünmesi önerilir.

### Kurum içi temiz başlangıç

Eski veri gerekmiyorsa D1 export/import yapılmaz. BT ekibi:

1. Boş veritabanı oluşturur.
2. Şemayı kurar veya backend migration'ını çalıştırır.
3. İlk yönetici/SSO grubunu tanımlar.
4. Arayüz ve API'yi aynı origin altında HTTPS ile yayınlar.

Bu yöntem veri migration'ını ortadan kaldırır; fakat Cloudflare backend'inin kurum teknolojisine uyarlanması yine gerekir.

### Kurum içi mevcut verilerle geçiş

1. D1'i SQL olarak export edin.
2. `sessions` tablosunu taşımayın.
3. `users` verisini SSO kararına göre dönüştürün.
4. `lab_state` JSON'unu yeni şemaya dönüştüren tek kullanımlık migration script'i hazırlayın.
5. Kayıt sayılarını ve örnek verileri karşılaştırın.
6. Eski sistemi salt okunur yapın.
7. Kabul testinden sonra adres/DNS geçişi yapın.

## Yapılandırma ve sırlar

Zorunlu runtime binding `DB`'dir. `wrangler.toml` içindeki `database_id` parola değildir ancak başka hesaba taşınamaz; yeni TUSAŞ D1 ID'siyle değiştirilmelidir.

Depoya eklenmemesi gerekenler:

- Cloudflare ve Git erişim token'ları
- Kullanıcı parolaları
- Özel anahtarlar ve TLS private key'leri
- Üretim SQL/JSON yedekleri
- Gizli veya kişisel veri

Bunlar kurumun secret manager veya onaylı güvenli aktarım yöntemiyle yönetilmelidir.

## Devir teslim kontrol listesi

### Kaynak kodu

- [ ] Son çalışan commit kurum deposuna aktarıldı
- [ ] Repo ve deployment sahipliği kişisel hesaptan çıkarıldı
- [ ] Test ve üretim ortamları ayrıldı
- [ ] Kişisel token'lar iptal edildi

### Veritabanı

- [ ] Temiz başlangıç mı, migration mı yapılacağı belirlendi
- [ ] Migration varsa SQL export güvenli konuma alındı
- [ ] Import sonrası kayıtlar kontrol edildi
- [ ] Eski `sessions` silindi
- [ ] Yedekleme ve geri yükleme test edildi

### Güvenlik

- [ ] TUSAŞ BT/Bilgi Güvenliği onayı alındı
- [ ] HTTPS etkin
- [ ] SSO veya hesap yönetimi yöntemi belirlendi
- [ ] İlk yetkili kullanıcı tanımlandı
- [ ] Rate limiting ve başarısız giriş politikası değerlendirildi
- [ ] Loglarda parola/token tutulmadığı doğrulandı

### Kabul testi

- [ ] Giriş yapmamış kullanıcı yalnızca görüntüleyebiliyor
- [ ] Onay bekleyen kullanıcı giriş yapıyor fakat ortak veriyi değiştiremiyor
- [ ] Yetkili kullanıcı değişiklik yapabiliyor
- [ ] Kullanıcıya özel yazıcı sırası korunuyor
- [ ] Yazıcı ve baskı işlemleri çalışıyor
- [ ] Planlı baskı doğru şekilde otomatik başlıyor
- [ ] Dakika/yüzde ile süre düzeltmesi ve takip eden işlerin kaydırılması doğru
- [ ] Otomatik ekleme 08:00–17:00 başlangıç aralığını ve hafta sonlarını uyguluyor
- [ ] Takvim sürükle-bırak çalışıyor
- [ ] Kayıtlı iş durumları doğru
- [ ] Yenileme sonrasında veri korunuyor
- [ ] Yedekten geri dönüş test edildi

## İşletim ve bakım

### Bütün oturumları sonlandırma

```sql
DELETE FROM sessions;
```

### D1 yedeği alma

```bash
npx wrangler d1 export VERITABANI_ADI --remote --output=backup.sql
```

Yedek kaynak kodu deposuna yüklenmemelidir.

### Güncelleme

Git entegrasyonunda `main` dalına gönderilen commit deployment başlatır. Üretimde test ortamı, code review ve onaylı release süreci kullanılmalıdır.

### Geri dönüş

Kod hatasında önceki başarılı deployment'a rollback yapılabilir. Veri hatasında doğrulanmış SQL yedeği gerekir. Kod rollback'i veritabanındaki değişiklikleri otomatik geri almaz.

## Resmî teknik kaynaklar

- [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/)
- [Cloudflare Pages bindings](https://developers.cloudflare.com/pages/functions/bindings/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)

## Sahiplik

Üretimde kaynak kodu deposu, Cloudflare projesi veya kurum sunucusu, veritabanı, yedekler, alan adı, deployment token'ları, yönetici hesapları ve olay müdahale prosedürleri TUSAŞ tarafından sahiplenilmelidir. Kişisel hesaplar üretim sisteminin kalıcı bağımlılığı olmamalıdır.
