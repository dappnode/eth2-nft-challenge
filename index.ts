import fs from "fs";
import got from "got";

const fromSlot = 327600;
const toSlot = 442799;
const graffitiToMatch = /dappnode/i;

const filepath = "block-record.csv";
const addressesOutputPath = "addresses.txt";
const indexedOutputPath = "validatorIndexes.txt";
const prysmApiUrl = "http://172.33.0.12:3500";
const beaconchaUrl = "https://beaconcha.in";

// Catch the SIGINT event to finish writing a line and not corrupt the CSV
let stop = false;
process.on("SIGINT", () => {
  stop = true;
});

async function runScript() {
  const record = new CsvRecord(filepath);
  const lastSlot = record.getLastSlot() ?? fromSlot;

  for (let slot = lastSlot + 1; slot <= toSlot && !stop; slot++) {
    const blocks = await fetchBlock(slot);
    for (const block of blocks) {
      record.addEntry({
        slot: parseInt(block.slot),
        proposerIndex: parseInt(block.proposerIndex),
        graffiti: parseGraffiti(block.body.graffiti),
      });
      console.log(`slot ${block.slot}`);
    }
  }

  const proposerIndexes = new Set<number>();

  for (const entry of record.readEntries()) {
    if (
      entry.slot >= fromSlot &&
      entry.slot <= toSlot &&
      graffitiToMatch.test(entry.graffiti)
    ) {
      proposerIndexes.add(entry.proposerIndex);
    }
  }

  const validatorIndexes = Array.from(proposerIndexes.values());
  console.log(`Proposer indexes: ${validatorIndexes.length}`);
  fs.writeFileSync(indexedOutputPath, validatorIndexes.join("\n"));

  const addresses = await fetchDepositAddresses(validatorIndexes);
  const addressesUnique = [...new Set(addresses)];
  console.log(
    `Eth1 addresses: ${addressesUnique.length} (total ${addresses.length})`
  );
  fs.writeFileSync(addressesOutputPath, addressesUnique.join("\n"));
}

// LOCAL FILE
// Use a CSV and write as a stream to process more efficiently

// Record is a CSV
const separator = ",";
const header = ["slot", "proposerIndex", "graffiti"].join(separator);
type Row = { slot: number; proposerIndex: number; graffiti: string };

class CsvRecord {
  filepath: string;
  stream?: fs.WriteStream;

  constructor(filepath: string) {
    if (!fs.existsSync(filepath)) fs.writeFileSync(filepath, header + "\n");
    this.filepath = filepath;
  }

  addEntry({ slot, proposerIndex, graffiti }: Row) {
    const row = [slot, proposerIndex, graffiti].join(separator);

    if (!this.stream)
      this.stream = fs.createWriteStream(filepath, { flags: "a" });
    this.stream.write(row + "\n");
  }

  getLastSlot(): number | null {
    const rows = fs.readFileSync(filepath, "utf8").trim().split("\n");
    const lastRow = rows[rows.length - 1]?.trim();
    if (!lastRow || lastRow === header) return null;
    const [slot] = lastRow.split(separator);
    return parseInt(slot);
  }

  readEntries(): Row[] {
    const entries: Row[] = [];
    const rows = fs.readFileSync(filepath, "utf8").trim().split("\n");
    for (const row of rows) {
      const [slot, proposerIndex, ...graffiti_] = row.split(separator);
      entries.push({
        slot: parseInt(slot),
        proposerIndex: parseInt(proposerIndex),
        graffiti: graffiti_.join(separator),
      });
    }
    return entries;
  }
}

// PRYSM API

interface BlockResponse {
  blockContainers: [
    {
      block: {
        block: {
          body: {
            graffiti: string; // "QlRDUyBadWcgdmFsaWRhdG9yAAAAAAAAAAAAAAAAAAA=";
          };
          proposerIndex: string; // "11516";
          slot: string; // "2";
        };
      };
      blockRoot: string; // "J1f2/YWQklzQAKhqPlQ/mKk+riN4F4OjPjRQRymorQw=";
    }
  ];
}

async function fetchBlock(slot: number) {
  const url = `${prysmApiUrl}/eth/v1alpha1/beacon/blocks?slot=${slot}`;
  const res = await got(url).json<BlockResponse>();
  return res.blockContainers.map((b) => b.block.block);
}

function parseGraffiti(base64: string): string {
  let buff = Buffer.from(base64, "base64");
  for (const [i, byte] of buff.entries()) {
    if (byte === 0) {
      buff = buff.slice(0, i);
    }
  }
  return buff.toString("utf8");
}

// BEACONCHA.IN API

interface DepositsResponse {
  status: "OK";
  data: [
    {
      amount: number; // 32000000000;
      from_address: string; // "0x27e124ed942ca70722e71e55efbb9bd7d824e3e3";
      publickey: string; // "0xb067201b3236ac5d566174e2a0392991ed6129cf5951f0feddca88ff8fe42d912c697f9ff38bcbd1c323001017909f05";
      removed: boolean; // false;
      valid_signature: boolean; // true;
    }
  ];
}

async function fetchDepositAddresses(validatorIndexes: number[]) {
  const addresses: string[] = [];

  // Up to 100 validator indicesOrPubkeys, comma separated
  const step = 100;
  for (let i = 0; i < validatorIndexes.length; i += step) {
    const indexes = validatorIndexes.slice(i, i + step);
    const param = encodeURIComponent(indexes.join(","));
    const url = `${beaconchaUrl}/api/v1/validator/${param}/deposits`;
    const res = await got(url).json<DepositsResponse>();

    for (const deposit of res.data) {
      if (
        deposit.amount < 32000000000 ||
        deposit.removed ||
        !deposit.valid_signature
      ) {
        console.log(`Bad deposit for pubkey: ${deposit.publickey}`);
      } else {
        addresses.push(deposit.from_address);
      }
    }
  }

  return addresses;
}

// Run script

runScript().catch((e) => {
  console.error(e);
  process.exit(1);
});
