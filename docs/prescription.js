// OCR runs in the browser. Only the engine/language files are downloaded; the image stays local.
const CDN = "https://cdn.jsdelivr.net/npm/";
let libraryPromise;

export function normalizeMedicine(value) {
  return String(value || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/\s+/g, " ").trim();
}

const NUMBER = "\\d+(?:[.,]\\d+)?";
const UNIT = "(?:mcg|[µμ]g|mg|kg|g|ml|iu|ui|cfu|ufc|%)";
const SCALE = "(?:(?:tỉ|tỷ|ti|ty|triệu|trieu|nghìn|nghin|million|billion)\\s*)?";
const STRENGTH = new RegExp(`${NUMBER}\\s*${SCALE}${UNIT}(?:\\s*[+/]\\s*(?:${NUMBER}\\s*)?${SCALE}${UNIT})*(?!\\p{L})`, "iu");
const NUMBERING = /^[\s'"‘’“”]*\(?\s*(\d{1,2})\s*[.,)/:-]\s*/;
const INSTRUCTION = /^(?:ngay\b|uong\b|sang\b|trua\b|chieu\b|toi\b|cach dung\b|moi\b|boi\b|nho\b|tiem\b|xit\b|sl\b|so luong\b)/;
const HEADER = /^(?:don thuoc|ho ten|benh nhan|tuoi|dia chi|chan doan|bac si|bs\b|ngay ke|loi dan|tai kham|phong kham|benh vien|luu y|tong cong|thanh tien|so ngay|so dien thoai)/;
// Product classification is not part of the medicine name. Do not strip release forms such as (SR).
const CLASSIFICATION = /\(\s*(?:NT|TPCN|TPBVSK|thực\s*phẩm\s*(?:chức\s*năng|bảo\s*vệ\s*sức\s*khỏe))\s*\)/iu;

function normalizeStrength(value) {
  return normalizeMedicine(value).replace(/\s/g, "").replace(/,/g, ".").replace(/μ/g, "µ")
    .replace(/(?:ti|ty)(?=(?:cfu|ufc))/g, "billion").replace(/trieu(?=(?:cfu|ufc))/g, "million")
    .replace(/ufc/g, "cfu").replace(/µg/g, "mcg").replace(/ui/g, "iu");
}

export function parseMedicine(value) {
  const text = String(value).replace(NUMBERING, "").trim();
  const strength = text.match(STRENGTH);
  const name = (strength ? text.slice(0, strength.index) : text).split(CLASSIFICATION)[0]
    .replace(/\s*(?:\bSL\s*[:.]?|\bsố lượng\s*:|[x×]\s*\d|\d+\s*(?:viên|vỉ|hộp|gói|ống|chai|lọ|tuýp)\b|\b(?:uống|ngày uống|cách dùng)\b).*$/iu, "")
    .replace(/[\s,:;\-–(]+$/u, "").trim();
  return { name, strength: strength ? strength[0].replace(/\s+/g, "").replace(/,/g, ".") : "" };
}

function uniqueMedicines(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = normalizeMedicine(`${item.name} ${item.strength}`);
    if (item.name.length < 2 || !/\p{L}/u.test(item.name) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function prescriptionCandidates(data) {
  const source = data.lines?.length ? data.lines : String(data.text || "").split(/\r?\n/).map(text => ({ text }));
  const lines = [];
  for (const line of source) {
    const previous = lines.at(-1);
    const strength = String(line.text || "").match(STRENGTH);
    if (previous && NUMBERING.test(previous.text) && !STRENGTH.test(previous.text) && strength &&
      /^[\s(]*$/.test(String(line.text).slice(0, strength.index))) {
      const confidences = [previous.confidence, line.confidence].filter(Number.isFinite);
      lines[lines.length - 1] = { ...previous, text: `${previous.text} ${line.text}`,
        words: [...(previous.words || []), ...(line.words || [])],
        confidence: confidences.length ? Math.min(...confidences) : undefined };
    } else lines.push(line);
  }
  const candidates = lines.flatMap(line => {
    const rawText = String(line.text || "").trim();
    const normalized = normalizeMedicine(rawText.replace(NUMBERING, ""));
    if (HEADER.test(normalized) || INSTRUCTION.test(normalized) ||
      (!NUMBERING.test(rawText) && !STRENGTH.test(rawText) && !CLASSIFICATION.test(rawText))) return [];
    const item = parseMedicine(rawText);
    if (!uniqueMedicines([item]).length) return [];
    const lineConfidence = Number.isFinite(line.confidence) ? line.confidence
      : Number.isFinite(data.confidence) ? data.confidence : null;
    const name = normalizeMedicine(item.name);
    const wordConfidences = (line.words || []).filter(word => {
      const text = normalizeMedicine(word.text).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      return text.length > 1 && name.includes(text) && Number.isFinite(word.confidence);
    }).map(word => word.confidence);
    const confidence = wordConfidences.length ? Math.min(lineConfidence ?? 100, ...wordConfidences) : lineConfidence;
    const unparsedTail = (rawText.split(CLASSIFICATION)[1] || "").replace(CLASSIFICATION, "")
      .replace(/\s*(?:[x×]\s*\d|SL\s*[:.]?|=\s*\d).*$/iu, "").trim();
    const suspicious = /[^\p{L}\p{N}\s().+/'’\-–]/u.test(item.name) ||
      (!NUMBERING.test(rawText) && CLASSIFICATION.test(rawText)) ||
      (!item.strength && CLASSIFICATION.test(rawText) && /[\p{L}\p{N}]/u.test(unparsedTail));
    return [{ ...item, rawText, confidence, suspicious,
      number: NUMBERING.test(rawText) ? Number(rawText.match(NUMBERING)[1]) : null }];
  });
  // Keep a classified medicine whose number was unreadable, but not an unnumbered ingredient note.
  return candidates.some(item => item.number != null)
    ? candidates.filter(item => item.number != null || CLASSIFICATION.test(item.rawText)) : candidates;
}

export function parsePrescriptionMedicines(text) {
  return uniqueMedicines(prescriptionCandidates({ text }).map(({ name, strength }) => ({ name, strength })));
}

function candidateScore(item) {
  return (item.confidence ?? 50) - (item.suspicious ? 25 : 0);
}

// Compare readings of the same numbered row; never concatenate conflicting OCR names into extra medicines.
export function selectPrescriptionReadings(readings) {
  const passes = readings.map(prescriptionCandidates);
  const passScore = items => items.reduce((sum, item) => sum + Math.max(0, candidateScore(item)) + (item.number ? 20 : 0), 0);
  const base = passes.reduce((best, items) => passScore(items) > passScore(best) ? items : best, []);
  const seen = new Set();
  return base.flatMap(item => {
    const alternatives = item.number == null ? [item]
      : passes.flatMap(items => items.filter(other => other.number === item.number));
    const selected = alternatives.reduce((best, other) => candidateScore(other) > candidateScore(best) ? other : best, item);
    const key = normalizeMedicine(medicineLabel(selected));
    if (seen.has(key)) return [];
    seen.add(key);
    const conflict = alternatives.some(other => normalizeMedicine(medicineLabel(other)) !== key);
    return [{ name: selected.name, strength: selected.strength, rawText: selected.rawText,
      confidence: selected.confidence,
      needsReview: selected.suspicious || conflict || selected.confidence == null || selected.confidence < 80 }];
  });
}

export function parseMedicineList(text) {
  // Preserve decimal commas in strengths such as 0,5 mg.
  return uniqueMedicines(String(text || "").split(/(?<!\d),|,(?!\d)|[;\n]+/).map(parseMedicine));
}

export function medicineLabel(item) {
  return [item.name, item.strength].filter(Boolean).join(" ");
}

export function matchesMedicine(requested, stock) {
  const medicine = parseMedicine(stock.name || "");
  const strength = normalizeStrength(stock.strength || medicine.strength);
  return normalizeMedicine(requested.name) === normalizeMedicine(medicine.name) &&
    (!requested.strength || normalizeStrength(requested.strength) === strength);
}

export async function preparePrescriptionImage(file, signal) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    signal.throwIfAborted();
    // Aim for readable text while bounding memory use on phones, even for large camera photos.
    const scale = Math.min(3, Math.max(1, 1800 / bitmap.width),
      3000 / Math.max(bitmap.width, bitmap.height), Math.sqrt(4000000 / (bitmap.width * bitmap.height)));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const enhanced = document.createElement("canvas");
    enhanced.width = width; enhanced.height = height;
    const ctx = enhanced.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    const gray = new Uint8Array(width * height);
    const histogram = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.round(image.data[i * 4] * 0.299 + image.data[i * 4 + 1] * 0.587 + image.data[i * 4 + 2] * 0.114);
      histogram[gray[i]]++;
    }
    let low = 0, high = 255, count = 0;
    while (low < 255 && count + histogram[low] < gray.length * 0.01) count += histogram[low++];
    count = 0;
    while (high > low && count + histogram[high] < gray.length * 0.005) count += histogram[high--];
    const range = Math.max(30, high - low);
    if (high > low) {
      for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, Math.round((gray[i] - low) * 255 / range)));
    }
    // Mild edge enhancement helps small print without discarding grayscale details.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const neighbours = gray[y * width + Math.max(0, x - 1)] + gray[y * width + Math.min(width - 1, x + 1)] +
          gray[Math.max(0, y - 1) * width + x] + gray[Math.min(height - 1, y + 1) * width + x];
        const value = Math.max(0, Math.min(255, Math.round(gray[i] * 1.6 - neighbours * 0.15)));
        image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = value;
      }
    }
    ctx.putImageData(image, 0, 0);
    // Local thresholding provides an independent reading for photos with shadows/uneven lighting.
    const stride = width + 1;
    const integral = new Uint32Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
      let sum = 0;
      for (let x = 0; x < width; x++) {
        sum += gray[y * width + x];
        integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + sum;
      }
    }
    const radius = Math.max(12, Math.round(width / 50));
    for (let y = 0; y < height; y++) {
      const top = Math.max(0, y - radius), bottom = Math.min(height, y + radius + 1);
      for (let x = 0; x < width; x++) {
        const left = Math.max(0, x - radius), right = Math.min(width, x + radius + 1);
        const mean = (integral[bottom * stride + right] - integral[top * stride + right] -
          integral[bottom * stride + left] + integral[top * stride + left]) / ((bottom - top) * (right - left));
        const i = y * width + x;
        image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = gray[i] < mean - 12 ? 0 : 255;
      }
    }
    const binary = document.createElement("canvas");
    binary.width = width; binary.height = height;
    binary.getContext("2d").putImageData(image, 0, 0);
    signal.throwIfAborted();
    return { enhanced, binary };
  } finally {
    bitmap.close();
  }
}

function loadLibrary() {
  if (!libraryPromise) {
    libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timer = setTimeout(() => fail(), 25000);
      const fail = () => {
        clearTimeout(timer);
        script.remove();
        libraryPromise = null;
        reject(new Error("Không tải được công cụ đọc ảnh. Hãy thử lại hoặc nhập tên thuốc."));
      };
      script.src = `${CDN}tesseract.js@5.1.1/dist/tesseract.min.js`;
      script.onload = () => {
        clearTimeout(timer);
        if (window.Tesseract?.createWorker) resolve(window.Tesseract);
        else fail();
      };
      script.onerror = fail;
      document.head.append(script);
    });
  }
  return libraryPromise;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function readPrescriptionImage(file, { signal, onProgress = () => {} }) {
  const timeoutSignal = AbortSignal.timeout(90000);
  const operation = AbortSignal.any([signal, timeoutSignal]);
  let worker;
  let finished = false;
  let images;
  let pass = 0;
  try {
    images = await preparePrescriptionImage(file, operation);
    const { createWorker } = await abortable(loadLibrary(), operation);
    let rejectWorkerError;
    const workerError = new Promise((_, reject) => { rejectWorkerError = reject; });
    // A worker that finishes initializing after cancellation must also be released.
    // Tesseract downloads vie/eng LSTM data from its official @tesseract.js-data packages on jsDelivr.
    const creating = createWorker("vie+eng", 1, {
      workerPath: `${CDN}tesseract.js@5.1.1/dist/worker.min.js`,
      corePath: `${CDN}tesseract.js-core@5.1.1`,
      // Tesseract already rejects the job promise; avoid an additional uncaught browser error.
      errorHandler: error => rejectWorkerError(new Error(String(error))),
      logger: event => {
        if (!operation.aborted && event.status === "recognizing text") onProgress((pass + event.progress) / 2);
      },
    }).then(created => {
      if (operation.aborted || finished) {
        void created.terminate();
        throw operation.reason || new DOMException("Đã dừng đọc ảnh", "AbortError");
      }
      worker = created;
      return created;
    });
    await abortable(Promise.race([creating, workerError]), operation);
    const recognize = image => abortable(Promise.race([worker.recognize(image, {
      rotateAuto: true, tessedit_pageseg_mode: pass ? "6" : "3",
      preserve_interword_spaces: "1", user_defined_dpi: "300",
    }), workerError]), operation);
    const first = (await recognize(images.enhanced)).data;
    let medicines = selectPrescriptionReadings([first]);
    const numbers = prescriptionCandidates(first).map(item => item.number).filter(number => number != null).sort((a, b) => a - b);
    const missingRow = numbers.some((number, index) => number !== index + 1);
    if (!medicines.length || missingRow || medicines.some(item => item.needsReview)) {
      pass = 1;
      const second = (await recognize(images.binary)).data;
      medicines = selectPrescriptionReadings([first, second]);
    }
    onProgress(1);
    return medicines;
  } finally {
    finished = true;
    if (worker) await worker.terminate();
    if (images) {
      images.enhanced.width = images.enhanced.height = 1;
      images.binary.width = images.binary.height = 1;
    }
  }
}
