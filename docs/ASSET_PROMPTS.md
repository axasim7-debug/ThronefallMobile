# برومتات الأصول — الدفعة الأولى (تجربة استطلاعية)

> **الاستخدام**: كل برومت مصمَّم لمرحلتين — (1) تولّد صورة 2D بموديل زي Midjourney/Flux/SDXL، (2) تحوّلها 3D عبر Meshy (Image-to-3D) للمباني والجنود. فن الكروت يفضل صورة 2D بس، من غير خطوة تحويل.
>
> **قبل التوليد بالكمية**: جرّب **مبنى واحد بس** (اقترح: القلعة `keep`) من الفئة دي الأول، وابعتهولي — أراجع الاتساق قبل ما تكمل باقي المجموعة، لأن أي انحراف في اللوحة/الإضاءة في أول صورة بيتضخّم لو اتكرر في 10 صور.

---

## 0. راسخة الطابع (Style Anchor) — لازم تتكرر في **كل** برومت

انسخ الجزء ده وحطّه في **آخر** كل برومت تحت، من غير تغيير، عشان الاتساق:

```
Style: cartoon mobile game asset, Clash Royale style, chunky rounded proportions,
smooth toon shading with soft ambient occlusion, warm single soft light source
from upper-left, saturated but not neon colors, thick dark clean outlines,
3D render look (not photo, not flat vector), isolated on plain flat light-grey
studio background, no shadows on the background, centered composition,
3/4 front-facing isometric-ish angle, high detail on a simple silhouette
```

**ليه ده مهم**: "isolated on plain background" و"3D render look" (مش "photo") بالتحديد بيحسّنوا نتيجة Meshy جداً — الأدوات دي مبنية على صور تشبه render مش صور حقيقية، والخلفية النضيفة بتسهّل فصل الشكل عن الخلفية أوتوماتيك.

---

## 1. المبنى التجريبي الأول — القلعة (Keep)

```
A short chunky medieval castle keep tower, light tan stone blocks, gold
trim banding near the roof, a small blue flag banner on top, single wide
entrance arch at the base, slightly weathered but not ruined, no
characters or figures standing on it, front-facing clean silhouette.

Style: cartoon mobile game asset, Clash Royale style, chunky rounded proportions,
smooth toon shading with soft ambient occlusion, warm single soft light source
from upper-left, saturated but not neon colors, thick dark clean outlines,
3D render look (not photo, not flat vector), isolated on plain flat light-grey
studio background, no shadows on the background, centered composition,
3/4 front-facing isometric-ish angle, high detail on a simple silhouette
```

**بعد التوليد**: لو الشكل عجبك، جرّب Image-to-3D عليه في Meshy. إعدادات مقترحة: PBR textures = on، target polycount = Low/Medium (موبايل)، **من غير Rigging** (مبنى ثابت).

**ابعت النتيجة (.glb) هنا وأنا أدمجها فوراً في `scene.ts` بدل الصندوق الحالي.**

---

## 2. باقي المباني (بعد ما نتأكد من القلعة)

### البرج الدفاعي (Tower)
```
A short round stone defense tower, same tan stone material as the castle
keep, a single narrow arrow-slit window, gold trim ring near the top,
a small red flag banner, squat and wide rather than tall, no characters
standing on it, front-facing clean silhouette.

[+ راسخة الطابع من قسم 0]
```

### المزرعة (Farm)
```
A small round wooden watermill-style farm building, brown wood planks,
a small waterwheel on one side, a thatched conical roof, tiny fenced
crop patch beside it, warm and cozy, no characters, front-facing clean
silhouette.

[+ راسخة الطابع من قسم 0]
```

### الثكنة (Barracks)
```
A squat wooden military barracks building, dark brown timber walls,
a red-tiled peaked roof, a rack of spears leaning against one wall,
a small chimney with smoke, no characters standing outside, front-facing
clean silhouette.

[+ راسخة الطابع من قسم 0]
```

---

## 3. الجنود — تجربة استطلاعية على اتنين بس أول

⚠️ **قبل ما تولّد**: الجنود محتاجين حرص إضافي في الاتساق — **نفس ارتفاع القاعدة، نفس زاوية الكاميرا، نفس نسبة الحجم للجسم** في كل صورة، عشان لما يترصّوا على الميدان يبانوا مجموعة واحدة مش أشكال متفرقة. لو أمكن، ولّد الاتنين في نفس الجلسة/المحادثة مع الموديل عشان يحافظ على نفس "الذاكرة البصرية" للطابع.

### مشاة (Infantry) — تحمّل عالي، بطيء
```
A short stocky armored foot soldier, thick heavy plate armor, round
shield in one hand, short sword in the other, standing in a simple
neutral standing pose facing forward, sturdy wide stance, heavy boots,
no helmet visor covering the face (friendly cartoon face visible),
full body visible head to toe, front-facing.

[+ راسخة الطابع من قسم 0]
```

### فرسان (Cavalry) — سريع، ضرر عالي
```
A short stocky soldier riding a small sturdy horse, light armor,
a raised lance or short sword, the horse mid-gallop pose but readable
silhouette (not blurry motion), same proportions and scale as other
troops in this set, full body and horse visible, front-facing.

[+ راسخة الطابع من قسم 0]
```

**بعد التوليد**: Image-to-3D بإعدادات: PBR = on، polycount = Low/Medium، **جرّب تفعيل Rigging** لو متوفر (auto-rig لبايبد) — ده بالظبط الجزء اللي التقييم قال إنه المخاطرة، فجرّبه وشوف الناتج قبل ما نكمل باقي الأربعة (نينجا، حارق، مهندس حصار).

**ابعت الاتنين (.glb) هنا، وأنا أقيّم**: هل الاتساق كويس؟ هل الريج شغال أو محتاج تعديل يدوي في Blender (أقدر أعمله)؟ وبعدين نقرر نكمل باقي الروستر بنفس الطريقة ولا نغيّر حاجة.

---

## 4. فن الكروت — 2D بس، مفيش تحويل 3D

نفس الطابع، لكن **كومبوزيشن بطاقة** بدل "شكل معزول". برومت واحد بيتكرر لكل الجنود/القادة بس تغيّر الوصف:

```
A trading card game character portrait, [DESCRIPTION HERE], bust/upper-body
shot facing slightly to the side, dramatic but friendly cartoon expression,
centered in frame with headroom at top for a card border to be added later,
simple soft-gradient colored background (not plain white), rim lighting
separating the character from the background.

Style: cartoon mobile game card art, Clash Royale style, chunky rounded
proportions, smooth toon shading, warm single soft light source from
upper-left, saturated but not neon colors, thick dark clean outlines,
3D render look, high detail on face and armor
```

استبدل `[DESCRIPTION HERE]` بوصف كل واحد (نفس أوصاف الجنود فوق، أو للقادة: "a heroic commander in ornate blue-and-gold armor with a flowing cape" للـWarlord مثلاً).

---

## تسلسل العمل المقترح

1. **القلعة بس** → صورة 2D → Meshy → ابعتها.
2. لو عجبتني، **باقي 4 المباني** بنفس الطريقة.
3. **مشاة + فرسان بس** (2D + Meshy + Rigging تجريبي) → ابعتهم.
4. أقيّم الاتساق والريجينج، وبعدين نقرر: نكمل الأربعة الباقية بنفس الطريقة، أو نعدّل المنهج الأول.
5. **فن الكروت** (كل الـ9 — 6 جنود + 3 قادة) مستقل تماماً عن الخطوات فوق، ممكن يحصل بالتوازي في أي وقت.
