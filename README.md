# Printers Lab 750 — Cloudflare Kurulumu

Bu klasör internet sitesinin tamamını içerir:

- İnternet sitesi için Cloudflare Pages
- `/api/state` sunucu işlemleri için Cloudflare Pages Functions
- Yazıcılar ve işlem geçmişi için Cloudflare D1
- Kaynak kodu ve otomatik yayınlama için GitHub

Herhangi bir derleme komutu, terminal, npm, ayrı sunucu, e-posta hizmeti veya Firebase hesabı gerekmez.

## Klasör yapısı

GitHub deponuzun ana dizinindeki yapı tam olarak şöyle olmalıdır:

```text
printers-lab-750/
├── functions/
│   └── api/
│       ├── auth.js
│       └── state.js
├── public/
│   ├── _routes.json
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── worker.js
├── wrangler.toml
└── README.md
```

ZIP dosyasını doğrudan GitHub'a yüklemeyin. Önce ZIP'i açın, ardından yukarıda gösterilen klasör ve dosyaları yükleyin.

## 1. Dosyaları GitHub'a yükleyin

1. GitHub'da yeni bir depo oluşturun. Depo adını, istediğiniz gizli adresle aynı yapabilirsiniz. Örneğin: `pl750-k7m4q2`.
2. Depo gizli (private) olabilir. GitHub sorduğunda Cloudflare'a bu depoya erişim izni verin.
3. Bu klasörün içindekileri deponun ana dizinine yükleyin.
4. GitHub'ın üst seviyede hem `public` hem `functions` klasörünü gösterdiğini kontrol edin.

## 2. Veritabanını oluşturun

1. Cloudflare kontrol panelini açın.
2. **Storage & Databases → D1 SQL Database** bölümüne gidin.
3. **Create database** seçeneğine basın.
4. Veritabanı adını `printers-lab-750-db` yapın.
5. Tablo oluşturmayın ve SQL komutu çalıştırmayın. Uygulama ilk kullanımda gerekli tabloyu ve örnek verileri otomatik oluşturur.

## 3. Pages internet sitesini oluşturun

1. Cloudflare'da **Workers & Pages → Create application → Pages → Connect to Git** yolunu izleyin.
2. GitHub'ı bağlayıp yüklediğiniz depoyu seçin.
3. Proje adını adresinizde görünmesini istediğiniz gizli ad olarak ayarlayın. Örneğin `pl750-k7m4q2`; adresiniz `pl750-k7m4q2.pages.dev` olur. Seçtiğiniz adın daha önce alınmamış olması gerekir. Bu `pages.dev` adresi sonradan değiştirilemediği için proje adını ilk kurulumda doğru seçin.
4. Derleme ayarlarını şöyle doldurun:

   - Production branch: `main`
   - Framework preset: `None`
   - Build command: boş bırakın
   - Build output directory: `public`
   - Root directory: boş bırakın

5. **Save and Deploy** seçeneğine basın.

Veritabanı bağlanmadan önce arayüz açılabilir. Bu normaldir.

## 4. D1 veritabanını siteye bağlayın

1. Cloudflare'da yeni Pages projesini açın.
2. **Settings → Bindings** bölümüne gidin.
3. Bir **D1 database binding** ekleyin.
4. Variable name alanına tam olarak `DB` yazın. Büyük harf kullanın ve boşluk bırakmayın.
5. Veritabanı olarak `printers-lab-750-db` seçeneğini seçin.
6. Kaydedin.
7. **Deployments** bölümünden son yayını yeniden yayınlayın. GitHub'a yeni bir commit göndermek de yeni yayın başlatır.

Cloudflare'ın verdiği `pages.dev` adresini açın. Yazıcı listesi gelmelidir. Bir test değişikliği yapıp sayfayı yenileyin. Değişiklik korunuyorsa veritabanı çalışıyor demektir.

## Siteyi daha sonra güncellemek

GitHub'daki dosyaları düzenleyin veya değiştirin. `main` dalına gönderilen her commit Cloudflare Pages tarafından otomatik olarak yayınlanır.

## Kayıt olan bir kullanıcıya değişiklik yetkisi verme

Yeni hesaplar siteyi görüntüleyebilir fakat varsayılan olarak değişiklik yapamaz. Yetki vermek için:

1. Cloudflare kontrol panelinde **Storage & Databases → D1 → pd750-gewh43 → Console** bölümünü açın.
2. Aşağıdaki komutta kullanıcı adını kayıt sırasında yazılan adla değiştirip çalıştırın:

```sql
UPDATE users SET can_edit = 1 WHERE name = 'Ali Mammedzada';
```

Yetkiyi kaldırmak için aynı komutta `can_edit = 0` kullanın. Kullanıcı sayfayı yenilediğinde yeni yetki durumu görünür.

Şifreler PBKDF2-SHA256 ile salt kullanılarak saklanır. Oturum belirteçleri yalnızca hash olarak D1 veritabanında tutulur ve tarayıcıya `HttpOnly`, `Secure`, `SameSite=Lax` çereziyle gönderilir.
