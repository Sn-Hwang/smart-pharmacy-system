const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../../docs/prescription.js'), 'utf8');
const parser = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('OCR extracts medicines and strengths, excluding patient details and dosage instructions', async () => {
  const { parsePrescriptionMedicines } = await parser;
  assert.deepEqual(parsePrescriptionMedicines(`ĐƠN THUỐC
Họ tên: Nguyễn Văn A
Chẩn đoán: Viêm họng
1. Paracetamol 500 mg   SL: 10 viên
Uống 500 mg khi sốt
2) Loratadine 10mg x 10 viên
3. Vitamin C
SL: 20 viên
Ngày 12/11/2026
Bác sĩ: Nguyễn Văn B`), [
    { name: 'Paracetamol', strength: '500mg' },
    { name: 'Loratadine', strength: '10mg' },
    { name: 'Vitamin C', strength: '' },
  ]);
});

test('manual editing supports multiple separators, decimal strengths and duplicate removal', async () => {
  const { parseMedicineList } = await parser;
  assert.deepEqual(parseMedicineList('Paracetamol 500 mg, Vitamin C; Loratadine 0,5 mg\nPARACETAMOL 500mg'), [
    { name: 'Paracetamol', strength: '500mg' },
    { name: 'Vitamin C', strength: '' },
    { name: 'Loratadine', strength: '0.5mg' },
  ]);
});

test('an unreadable prescription does not invent a medicine list', async () => {
  const { parsePrescriptionMedicines, parseMedicineList } = await parser;
  assert.deepEqual(parsePrescriptionMedicines('ĐƠN THUỐC\nHọ tên: Nguyễn Văn A\nNgày 12/11/2026'), []);
  assert.deepEqual(parsePrescriptionMedicines(''), []);
  assert.deepEqual(parseMedicineList(' , ; \n'), []);
});

test('stock matching respects exact medicine names and reviewed strengths', async () => {
  const { matchesMedicine } = await parser;
  const requested = { name: 'Paracetamol', strength: '500mg' };
  assert.equal(matchesMedicine(requested, { name: 'PARACETAMOL 500 mg' }), true);
  assert.equal(matchesMedicine(requested, { name: 'Paracetamol', strength: '500 mg' }), true);
  assert.equal(matchesMedicine(requested, { name: 'Paracetamol', strength: '250mg' }), false);
  assert.equal(matchesMedicine(requested, { name: 'Paracetamol Plus', strength: '500mg' }), false);
  assert.equal(matchesMedicine({ name: 'Vitamin C', strength: '' }, { name: 'Vitamin C 500mg' }), true);
});
