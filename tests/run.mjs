#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const pure = html.match(/\/\/ === PURE_START ===([\s\S]*?)\/\/ === PURE_END ===/);
if (!pure) {
  console.error('FAIL: маркери PURE_START/PURE_END відсутні в index.html');
  process.exit(1);
}

const api = new Function(
  pure[1] +
    '; return { isValidRnokpp, extractCodeRows, parseCertificate, classifyRows, validate, generateXML, encodeCp1251, STI_CODE_RE, CAT_CODES, escHtml };'
)();

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed++;
  } else {
    console.log('ok:', msg);
  }
}

assert(api.isValidRnokpp('1234567899'), 'валідний РНОКПП 1234567899');
assert(api.isValidRnokpp('9000000002'), 'валідний РНОКПП з від’ємною проміжною сумою');
assert(!api.isValidRnokpp('1234567890'), 'невалідна контрольна цифра');
assert(!api.isValidRnokpp('123456789'), 'не 10 цифр');

assert(api.escHtml('<img src=x onerror=alert(1)>').includes('&lt;img'), 'escHtml екранує теги');

const cert = [
  'ІВАНЕНКО Прізвище ПЕТРО Ім\'я ІВАНОВИЧ По батькові',
  '1234567899 Реєстраційний номер облікової картки',
  'паспорта 403 Головне управління ДПС у Дніпропетровській області Код та назва територіального органу',
  'Електронна пошта user@example.com',
  'ТОВ «РОМАШКА» Січень 2025 25000.00 25000.00 4500.00 4500.00 1250.00 1250.00 101 -',
  'ТОВ «ДІЯСОФТ» Лютий 2025 20000.00 20000.00 1000.00 1000.00 1000.00 1000.00 101 -',
  'ФОП Коваленко Березень 2025 8000.00 8000.00 1440.00 1440.00 400.00 400.00 102 -',
  'АТ «ОЩАД» Квітень 2025 150.00 150.00 0.00 0.00 0.00 0.00 129 -',
  'ТОВ «ІНШЕ» Травень 2025 100.00 100.00 18.00 18.00 5.00 5.00 127 - Доходи',
].join(' ');

const parsed = api.parseCertificate(cert);
assert(parsed.last === 'ІВАНЕНКО', 'прізвище з довідки: ' + parsed.last);
assert(parsed.first === 'ПЕТРО', 'ім’я з довідки: ' + parsed.first);
assert(parsed.middle === 'ІВАНОВИЧ', 'по батькові: ' + parsed.middle);
assert(parsed.tin === '1234567899', 'РНОКПП з мітки');
assert(parsed.year === '2025', 'рік з рядків доходу, не з шапки');
assert(parsed.email === 'user@example.com', 'email за міткою');
assert(parsed.stiCode === '403', 'код ДПІ зі сегмента');
assert(parsed.rows.length === 3, 'рядки 101+102: ' + parsed.rows.length);
assert(parsed.nonTaxable === 150, 'код 129 → 11.3: ' + parsed.nonTaxable);
assert(!parsed.otherCodes['129'] && !parsed.otherCodes['101'] && !parsed.otherCodes['102'], '101/102/129 не в otherCodes');
assert(parsed.otherCodes['127'] === 1, 'код 127 лишається в otherCodes');

const buckets = api.classifyRows(parsed.rows);
assert(Math.round(buckets.salary.income) === 25000, '10.1 зарплата 18%: ' + buckets.salary.income);
assert(Math.round(buckets.civil.income) === 8000, '10.2 ЦПД 18%: ' + buckets.civil.income);
assert(Math.round(buckets.diia.income) === 20000, '10.3 Дія Сіті 5%: ' + buckets.diia.income);

const hyphen = api.parseCertificate('ПОДВІЙНЕ-ПРІЗВИЩЕ Прізвище ДАРʼЯ Імʼя');
assert(hyphen.last.includes('ПОДВІЙНЕ'), 'дефіс у прізвищі: ' + hyphen.last);
assert(hyphen.first === 'ДАРʼЯ', 'апостроф ʼ в імені: ' + hyphen.first);

const mixedYears = api.parseCertificate(
  'Закон 2024 формування 2026 ТОВ «А» Січень 2025 1000.00 1000.00 180.00 180.00 50.00 50.00 101 - ' +
  'ТОВ «Б» Січень 2024 900.00 900.00 162.00 162.00 45.00 45.00 101 -'
);
assert(mixedYears.year === '2025' || mixedYears.year === '2024', 'рік обрано з рядків');
assert(mixedYears.excludedYearRows === 1, 'рядок іншого року виключено: ' + mixedYears.excludedYearRows);

const base = {
  tin: '1234567899', last: 'Іваненко', first: 'Петро', middle: 'Іванович',
  year: String(new Date().getFullYear() - 1),
  income101: 25000, pdfo101: 4500, vz101: 1250,
  income102: 8000, pdfo102: 1440, vz102: 400,
  income103: 20000, pdfo103: 1000, vz103: 1000,
  nonTax: 150,
  cat: 'H05<script>', sti: '403', stiName: 'ГУ ДПС у Дніпропетровській області',
  creg: '4', craj: '12', email: 'user@example.com',
  city: 'м. Камʼянське', street: 'вул. Центральна', build: '1',
  apt: '', zip: '51900', tel: '+380501112233',
};

assert(api.validate({ ...base, tin: '1234567890' }).some(e => /РНОКПП/.test(e)), 'validate ловить невалідний РНОКПП');
assert(api.validate({ ...base, creg: '' }).some(e => /C_REG/.test(e)), 'validate вимагає C_REG');
assert(api.validate({ ...base, city: '' }).some(e => /населений/.test(e)), 'validate вимагає місто');
assert(api.validate({ ...base, sti: '12' }).some(e => /C_STI_ORIG/.test(e)), 'validate відхиляє короткий код ДПІ');
assert(api.validate(base).length === 0, 'повна форма проходить validate: ' + api.validate(base).join('; '));

const xml = api.generateXML(base);
assert(xml.includes('<R0101G3>25000.00</R0101G3>'), 'блок 10.1');
assert(xml.includes('<R0102G3>8000.00</R0102G3>'), 'блок 10.2');
assert(xml.includes('<R0103G3>20000.00</R0103G3>'), 'блок 10.3');
assert(xml.includes('<R0113G3>150.00</R0113G3>'), 'рядок 11.3');
assert(xml.includes('<H05>1</H05>'), 'категорія whitelist, не інʼєкція тега');
assert(!xml.includes('<H05<script>'), 'cat не стає ім’ям тега');
assert(xml.includes('<R010G3>53000.00</R010G3>'), 'рядок 10 = сума 10.1+10.2+10.3');

const zeroPdfo = api.generateXML({ ...base, income101: 100, pdfo101: 0, vz101: 0, income102: 0, income103: 0, nonTax: 0 });
assert(zeroPdfo.includes('<R0101G4>0.00</R0101G4>'), 'нульовий ПДФО не відкидається');

const { unmapped } = api.encodeCp1251('Камʼянське — тест… «цитата»');
assert(unmapped.length === 0, 'CP1251 мапить ʼ … «»: ' + unmapped.join(''));
const ctrl = api.encodeCp1251('A\x01B');
assert(Buffer.from(ctrl.bytes).toString('latin1') === 'AB', 'control-символи XML 1.0 викидаються');

mkdirSync('/tmp/taxprosto-tests', { recursive: true });
const xmlPath = '/tmp/taxprosto-tests/declaration.xml';
const { bytes } = api.encodeCp1251(xml);
writeFileSync(xmlPath, Buffer.from(bytes));
try {
  execFileSync('xmllint', [
    '--noout',
    '--schema', join(root, 'knowledge/xsd/F0100215.xsd'),
    xmlPath,
  ], { encoding: 'utf8' });
  console.log('ok: xmllint XSD F0100215');
} catch (err) {
  console.error('FAIL: xmllint\n', err.stderr || err.stdout || err.message);
  failed++;
}

const script = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!script) {
  console.error('FAIL: немає module script');
  failed++;
} else {
  const stub = script[1].replace(
    /import \* as pdfjsLib from 'https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/[^']+';/,
    'const pdfjsLib = { GlobalWorkerOptions: {}, getDocument() { return { promise: Promise.resolve({ numPages: 0 }) }; } };'
  ).replace(
    'pdfjsLib.GlobalWorkerOptions.workerSrc = await verifiedWorkerSrc();',
    'pdfjsLib.GlobalWorkerOptions.workerSrc = "stub";'
  );
  const stubPath = '/tmp/taxprosto-tests/extracted.mjs';
  writeFileSync(stubPath, stub);
  try {
    execFileSync('node', ['--check', stubPath], { encoding: 'utf8' });
    console.log('ok: node --check extracted module');
  } catch (err) {
    console.error('FAIL: syntax\n', err.stderr || err.message);
    failed++;
  }
}

assert(html.includes('pdf.js/4.10.38'), 'pdf.js оновлено з 4.0.379');
assert(html.includes('isEvalSupported: false'), 'isEvalSupported вимкнено');
assert(html.includes('Content-Security-Policy'), 'CSP meta присутній');
assert(html.includes('форма F0100215'), 'шапка без застарілого 0100424');
assert(html.includes('п. 179.2 ПКУ'), 'попередження п. 179.2 на кроці 1');

if (failed) {
  console.error(`\n${failed} перевірок не пройшли`);
  process.exit(1);
}
console.log('\nУсі перевірки пройшли');
