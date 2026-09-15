# السيرفر (Thronefall.Server)

السيرفر الـ**Authoritative** للعبة (راجع `docs/GAME_DESIGN.md` §5.3) — مصدر الحقيقة الوحيد لحالة أي مباراة. العميل (`client/`) شاشة عرض وتواصل بس، مفيش منطق لعبة عليه.

## البنية

| المشروع | الغرض |
|---|---|
| `Thronefall.Engine` | **محرك المحاكاة الفعلي** — نقل C# أمين لـ`tools/balance-sim/src/{content,engine,strategies}.js`. نفس الاقتصاد، نفس نموذج القتال (سور←برج←مزرعة←قلعة)، نفس نظام القادة والغضب، نفس نظام حسم انتهاء الوقت. |
| `Thronefall.Engine.Tests` | اختبارات xUnit — نفس ثوابت `tools/balance-sim/test/balance.test.js` (تماثل المرايا، عدم انهيار فوري، إلخ) **+ اختبارات مضاهاة (cross-validation)** ضد أرقام محققة فعلياً من محرك JS، للتأكد إن النقل ما غيّرش السلوك. |
| `Thronefall.Api` | ASP.NET Core — نقطة WebSocket أولية (`/ws/demo-match`) بتشغّل مباراة بين بوتات الاختبار وتبث النتيجة. **إثبات اتصال real-time شغال، مش بروتوكول اللعبة الفعلي النهائي بعد.** |

## ليه محرك منفصل عن JS بدل ما نستخدم نفس الكود؟

`tools/balance-sim` (JS/Node) هو أداة التكرار السريع لضبط الأرقام — سهل التعديل والاختبار الفوري. لكن **السيرفر الفعلي اللي المباريات الحقيقية هتشتغل عليه لازم يكون .NET** (قرار معماري من `docs/GAME_DESIGN.md`). فبنحافظ على الاتنين **متزامنين عمداً**: أي رقم يتضبط ويتأكد في JS، يتنقل هنا بعدها بنفس القيمة بالظبط — والاختبارات المضاهاة (`CrossValidate_*` في `MatchEngineTests.cs`) هي اللي بتضمن التزامن ده، مش مجرد نية طيبة.

## التشغيل

```bash
# محتاج .NET 8 SDK (dotnet --version)
cd server
dotnet test Thronefall.Engine.Tests/Thronefall.Engine.Tests.csproj   # اختبارات المحرك
dotnet run --project Thronefall.Api/Thronefall.Api.csproj            # يشغّل السيرفر على http://localhost:5246
```

جرّب نقطة الـWebSocket (بعد ما تشغّل السيرفر):

```bash
# GET /health للتأكد إنه شغال
curl http://localhost:5246/health

# اتصل بـ /ws/demo-match?a=eco&b=atk (أي أداة WebSocket، أو chromium-cli، أو سكريبت Node بـ`ws`)
```

## لسه مش موجود (الخطوة الجاية)

- بروتوكول اللعبة الحقيقي: استقبال أوامر لاعب فعلية (ابنِ، جهّز جندي، فعّل مهارة قائد) عبر WebSocket، مش تشغيل بوتات فقط.
- محاكاة real-time فعلية (tick بالثانية أثناء المباراة الحية، مش تشغيل المباراة كاملة فورياً وبث النتيجة).
- الحسابات، تسجيل الدخول، تخزين تقدّم اللاعب (بطاقات، ليفلات، معدات).
- Matchmaking بالكؤوس (`docs/GAME_DESIGN.md` §موديل الربح والمنافسة).
