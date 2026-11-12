// OCR runs in the browser. Only the engine/language files are downloaded; the image stays local.
const CDN = "https://cdn.jsdelivr.net/npm/";
let libraryPromise;

export function normalizeMedicine(value) {
  return String(value || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/\s+/g, " ").trim();
}

const STRENGTH = /\d+(?:[.,]\d+)?\s*(?:mcg|µg|mg|g|ml|iu|ui|%)(?:\s*\/\s*(?:\d+(?:[.,]\d+)?\s*)?(?:mcg|µg|mg|g|ml|iu|ui))?(?!\p{L})/iu;
const NUMBERING = /^\s*\d{1,2}\s*[.)/:-]\s*/;
const INSTRUCTION = /^(?:ngay\b|uong\b|sang\b|trua\b|chieu\b|toi\b|cach dung\b|moi\b|boi\b|nho\b|tiem\b|xit\b|sl\b|so luong\b)/;
const HEADER = /^(?:don thuoc|ho ten|benh nhan|tuoi|dia chi|chan doan|bac si|bs\b|ngay ke|loi dan|tai kham|phong kham|benh vien)/;

export function parseMedicine(value) {
  const text = String(value).replace(NUMBERING, "").trim();
  const strength = text.match(STRENGTH);
  const name = (strength ? text.slice(0, strength.index) : text)
    .replace(/\s*(?:\bSL\s*[:.]?|\bsố lượng\s*:|[x×]\s*\d|\d+\s*(?:viên|vỉ|hộp|gói|ống|chai|lọ|tuýp)\b|\b(?:uống|ngày uống|cách dùng)\b).*$/iu, "")
    .replace(/[\s,:;\-–(]+$/u, "").trim();
  return { name, strength: strength ? strength[0].replace(/\s+/g, "").replace(",", ".") : "" };
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

export function parsePrescriptionMedicines(text) {
  return uniqueMedicines(String(text || "").split(/\r?\n/).filter(line => {
    const normalized = normalizeMedicine(line.replace(NUMBERING, ""));
    return !HEADER.test(normalized) && !INSTRUCTION.test(normalized) &&
      (NUMBERING.test(line) || STRENGTH.test(line));
  }).map(parseMedicine));
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
  const strength = normalizeMedicine(stock.strength || medicine.strength).replace(/\s/g, "").replace(",", ".");
  return normalizeMedicine(requested.name) === normalizeMedicine(medicine.name) &&
    (!requested.strength || normalizeMedicine(requested.strength).replace(/\s/g, "") === strength);
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
  try {
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
        if (!operation.aborted && event.status === "recognizing text") onProgress(event.progress);
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
    const { data } = await abortable(Promise.race([worker.recognize(file), workerError]), operation);
    return parsePrescriptionMedicines(data.text);
  } finally {
    finished = true;
    if (worker) await worker.terminate();
  }
}
