// server/seed.js — populates the items table with 100 deterministic profiles.
// Idempotent: rerun any time, the same id will UPSERT the same row.

const db = require('./db');

const NAMES = [
  "Alice","Ben","Clara","Dylan","Eva","Felix","Grace","Henry","Iris","Jake",
  "Kara","Leo","Mia","Noah","Olivia","Pablo","Quinn","Ryan","Sofia","Theo",
  "Uma","Victor","Willa","Xander","Yara","Zoe","Aiden","Bella","Carlos","Diana",
  "Ethan","Fiona","George","Hannah","Ivan","Julia","Kai","Luna","Marco","Nina",
  "Owen","Priya","Quentin","Riley","Sam","Tara","Umar","Vera","Will","Xena",
  "Yusuf","Zane","Aria","Beatrice","Caleb","Damon","Elias","Finn","Gemma","Hugo",
  "Isla","Jasper","Kit","Lila","Milo","Naomi","Oscar","Penny","Reuben","Silas",
  "Tessa","Ulises","Vivian","Wesley","Yasmin","Zayn","Amir","Brooke","Cyrus","Daisy",
  "Eli","Freya","Gus","Harper","Inez","Jonas","Kira","Liam","Maya","Nia",
  "Ophelia","Piper","Reza","Sage","Tomas","Una","Vince","Wren","Xiulan","Yuna"
];

const JOBS = [
  "software engineer","UX designer","middle-school teacher","wildlife photographer","line cook",
  "ER nurse","novelist","specialty-coffee barista","architect","marine biologist",
  "indie musician","startup founder","art therapist","documentary filmmaker","data scientist",
  "investigative journalist","park ranger","sommelier","civil engineer","yoga instructor"
];

const HOBBIES = [
  "trail running","rock climbing","baking sourdough","collecting vinyl","playing chess",
  "salsa dancing","fly fishing","writing poetry","brewing kombucha","cycling at dawn",
  "stand-up comedy","sea kayaking","stargazing","pottery","jiu-jitsu",
  "growing herbs","painting murals","board games","learning Mandarin","DJing house sets"
];

const TRAITS = [
  "Adventurous","Quietly witty","Endlessly curious","Big-hearted","Ambitious",
  "Laid-back","Recklessly creative","Stubbornly optimistic","Thoughtful","Spontaneous",
  "Bookish","Sharply funny","Grounded","Quirky","Easy-going"
];

const PROMPTS = [
  "Looking for someone who'll argue about",
  "Won't shut up about",
  "Will absolutely beat you at",
  "Currently obsessed with",
  "Two truths: I love",
  "On Sundays you'll find me",
  "My controversial take:",
  "Best decision I made this year:"
];

const PROMPT_TAILS = [
  "the right way to make pasta carbonara.",
  "the new Bowie biography I just finished.",
  "Mario Kart on Rainbow Road.",
  "learning to surf at 30.",
  "long walks and short emails.",
  "cooking something I can't pronounce.",
  "pineapple does belong on pizza.",
  "quitting my comfortable job to travel."
];

const BG = "ffd5dc,ffdfbf,c0aede,d1d4f9,b6e3f4,c0e5e3,fde68a,fecaca";
const pick = (arr, seed) => arr[seed % arr.length];

function generate() {
  return Array.from({ length: 100 }, (_, i) => {
    const name = NAMES[i];
    const age  = 22 + ((i * 7) % 17);
    return {
      id:          `p${String(i + 1).padStart(3, '0')}`,
      name:        `${name}, ${age}`,
      description: `${pick(TRAITS, i*3+1)} ${pick(JOBS, i*5+2)} into ${pick(HOBBIES, i*11+3)}. ${pick(PROMPTS, i*13+5)} ${pick(PROMPT_TAILS, i*17+7)}`,
      imageUrl:    `https://api.dicebear.com/9.x/lorelei/svg?seed=${encodeURIComponent(name + i)}&backgroundColor=${BG}`
    };
  });
}

const upsert = db.prepare(`
  INSERT INTO items (id, name, description, image_url)
  VALUES (@id, @name, @description, @imageUrl)
  ON CONFLICT(id) DO UPDATE SET
    name        = excluded.name,
    description = excluded.description,
    image_url   = excluded.image_url
`);

const items = generate();
const tx = db.transaction(rows => { for (const r of rows) upsert.run(r); });
tx(items);

// Optional admin hook: drop a data/extra-items.json file alongside the DB to
// add or override items WITHOUT EDITING ANY CODE. Format is an array of
// { id, name, description, imageUrl }. Re-running seed UPSERTs by id.
const path = require('path');
const fs = require('fs');
const EXTRA = path.join(__dirname, '..', 'data', 'extra-items.json');
let extras = 0;
if (fs.existsSync(EXTRA)) {
  try {
    const list = JSON.parse(fs.readFileSync(EXTRA, 'utf8'));
    if (!Array.isArray(list)) throw new Error('expected an array');
    const extraTx = db.transaction(rows => {
      for (const r of rows) {
        if (typeof r.id !== 'string' || typeof r.name !== 'string' || typeof r.imageUrl !== 'string') {
          throw new Error(`invalid item entry: ${JSON.stringify(r)}`);
        }
        upsert.run({ id: r.id, name: r.name, description: r.description || '', imageUrl: r.imageUrl });
      }
    });
    extraTx(list);
    extras = list.length;
  } catch (e) {
    console.error(`Failed to load ${EXTRA}: ${e.message}`);
    process.exit(1);
  }
}

console.log(`Seeded ${items.length} items + ${extras} from extra-items.json into data/swipematch.db`);
