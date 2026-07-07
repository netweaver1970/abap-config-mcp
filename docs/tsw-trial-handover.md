# SAP TSW Trial — Setup & Handover (A4H)

**System:** A4H / client 250 — S/4HANA 2025 (SAP_BASIS 816, S4CORE 109, **IS-OIL 809**)
**Module:** TSW — Trader's & Scheduler's Workbench (IS-Oil **Downstream / TD**, dev area **OIJ**)
**Purpose:** stand up a minimal, working TSW scenario (nomination → ticket → stock projection) for evaluation.
**Audience:** SA colleague, to **verify and replay** on this or another IS-Oil system.
**Author / date:** prepared 2026-07-07.

> **How to read this.** Each configuration step lists: the **IMG path** (SPRO) or **transaction**, the **config object / table(s)** it writes, a **recommended trial value**, and a **verification query** (`SE16`/`execute_data_query`) so you can confirm the result independently. Steps already executed on A4H are marked **✅ DONE (A4H)**; everything else is **☐ TO DO** in the IMG/cockpit.

---

## 0. Executive summary

- **IS-Oil REQUIRES a Switch-Framework activation** and it is currently **OFF** on this box. Business function **`OIL_REVENUE_ACCOUNTING`** (the IS-Oil umbrella — bundles switches `OIJ_TSW` TSW, `OIB_QCI` HPM, `OIG_BULK_TRANSPORT` TD, `OIA_EXCHANGES`, `OIH_EXCISE_DUTY`, …) is **inactive** (0 rows in `SFW_ACTIVE_B2`). Switch-gated transactions (e.g. **`O4NCN`**) raise **SFW052** until it is activated. **Activate it FIRST — before any config below** (see §1.5).
- **TSW customizing is greenfield** on A4H — every backbone config table is empty (see §1.3). This is a from-scratch build, not a reuse of delivered sample config.
- **4 oil plants have been created** as the org-structure foundation (§2) — ✅ DONE.
- The remaining work is: HPM quantity-conversion foundation → oil materials → TSW basic settings + number ranges → TSW locations → nomination/ticket/SPW config → trial run. All laid out below.

**Effort note.** TSW is a specialist module. The nomination/ticket/SPW customizing is interdependent and partly view-cluster (SM34) maintenance with validation logic — do it in the IMG in the sequence below, not by raw table writes.

---

## 1. Verified baseline (how the system looks *before* TSW config)

### 1.1 Components
| Check | Result | How verified |
|---|---|---|
| IS-Oil installed | **IS-OIL 809** | `CVERS` |
| S/4 core | S4CORE 109 / SAP_BASIS 816 | `CVERS` |
| IS-Oil business function active? | **NO — `OIL_REVENUE_ACCOUNTING` is INACTIVE** (must activate, §1.5) | `SELECT bfunction FROM sfw_active_b2 WHERE bfunction='OIL_REVENUE_ACCOUNTING'` → 0 rows |

### 1.2 TSW is present (transactions)
| Function | Tx |
|---|---|
| Trader's & Scheduler's Workbench (cockpit) | **O4T0** |
| Stock Projection Worksheet (SPW) | **O4TB**, generate **O4TC**, HANA engine **O4TCN_HDB** |
| Tickets — enter / change / display / delete | **O4TE / O4TF / O4TG / O4TH** |
| Three-way pegging | **O4T3WP** |
| Deal groups | **O4TDG** |
| TD transport / TD master data | **O4S0 / O4S1** |
| Shipment planning workbench | **O4PX** |

> `O3U_*` transactions are IS-Oil **Upstream (PRA)** — a different module, ignore for TSW.

### 1.3 TSW customizing is empty (the greenfield proof)
`execute_data_query` / SE16 row counts, all **0** before this build:

| Table | Meaning | Rows |
|---|---|---|
| `OIJLOCT` | TSW location types | 0 |
| `OIJTSWMOT` | TSW modes of transport | 0 |
| `OIJTSWMVTY` | TSW movement types | 0 |
| `OIJSCHEMA` | Nomination schema | 0 |
| `OIJTCAL` | Transport calendar | 0 |
| `OIJFCPRF` | Forecast profile (SPW) | 0 |

**Verification (run any time to see progress):**
```sql
SELECT 'OIJLOCT'    AS t, COUNT(*) AS n FROM oijloct
-- repeat per table, or SE16 → row count
```

### 1.4 Number-range objects present on the box (intervals still to be set)
| NR object | Used for |
|---|---|
| `OIJNOM` | Nominations |
| `OIK37` | Tickets (TD) |
| `OIJPEG` | Pegging |
| `OIJ_VERS` | SPW / what-if versions |
| `OIJ_EL_TKT`, `OIJ_MOBTKT` | Electronic / mobile tickets |

### 1.5 ⚠️ REQUIRED FIRST — activate IS-Oil business function (`SFW5`)
IS-Oil is **off** at the Switch Framework. Until activated, switch-gated transactions raise **SFW052** (proven with `O4NCN`).

| | |
|---|---|
| Business function | **`OIL_REVENUE_ACCOUNTING`** (IS-Oil umbrella) |
| Bundles switches | `OIJ_TSW` (TSW), `OIB_QCI` (HPM quantity conversion), `OIG_BULK_TRANSPORT` (TD), `OIA_EXCHANGES`, `OIH_EXCISE_DUTY`, `OIC_COMMODITIES`, … |
| Current state | **INACTIVE** |
| How | `SFW5` → select `OIL_REVENUE_ACCOUNTING` → *Planned Status = activate* → **Activate Changes** (runs in background) |

**Cautions:** (1) BF activation is typically **one-way** — check the reversibility indicator in SFW5; take a backup first. (2) System-wide **Basis** action; SFW5 flags any prerequisite BFs. (3) Do this **before** any config/master-data below — it lights up TSW + HPM + TD together.

**Trace (how this was determined):** `O4NCN` → package `OIJ` (`TADIR`) → switch `OIJ_TSW` (`SFW_PACKAGE`) → business function `OIL_REVENUE_ACCOUNTING` (`SFW_BF_SW`) → not in `SFW_ACTIVE_B2`.
**Verification (after activating):** `SELECT bfunction FROM sfw_active_b2 WHERE bfunction='OIL_REVENUE_ACCOUNTING';` → 1 row.

---

## 2. Phase 0 — Org structure (oil plants) ✅ DONE (A4H)

Four **non-retail logistics plants** created as the physical locations TSW will plan. Built on A4H by copying delivered model plants with the standard entity copier (**EC02**), then re-pointing name/city/company code.

| Plant | Name | City | Country | Company code | Copied from |
|---|---|---|---|---|---|
| **OGNT** | Ghent Oil Terminal | Ghent | BE | Z100 | 2510 |
| **OANT** | Antwerp Oil Terminal | Antwerp | BE | Z100 | 2510 |
| **OCPT** | Cape Town Oil Terminal | Cape Town | ZA | Z200 | 6410 |
| **OJHB** | Johannesburg Oil Depot | Johannesburg | ZA | Z200 | 6410 |

Each plant inherited a full config set (91 dependent tables) **and 11 storage locations**, including **`…Q` Main Tank** and **`…T` Day Tank** (`251x` prefix for BE plants, `641x` for ZA plants) — reuse these as TSW tank storage.

**To replay on another system (standard IMG, no engine):**
1. `SPRO` → Enterprise Structure → Definition → Logistics-General → **Define, copy, delete, check plant** → *Copy plant* (**EC02**): source `2510` (BE) or `6410` (ZA) → target `OGNT`/`OANT`/`OCPT`/`OJHB`.
2. `OX10` — edit each new plant: **Name** + **City** (Ghent / Antwerp / Cape Town / Johannesburg).
3. `OX18` (or valuation-area assignment) — assign plant → company code: BE plants → **Z100**, ZA plants → **Z200**.

**Verification:**
```sql
SELECT werks, name1, ort01, land1, vlfkz FROM t001w
 WHERE werks IN ('OGNT','OANT','OCPT','OJHB');           -- VLFKZ must be blank (non-retail)
SELECT bwkey, bukrs FROM t001k
 WHERE bwkey IN ('OGNT','OANT','OCPT','OJHB');           -- OGNT/OANT=Z100, OCPT/OJHB=Z200
SELECT werks, lgort, lgobe FROM t001l
 WHERE werks='OGNT' ORDER BY lgort;                      -- see …Q Main Tank, …T Day Tank
```

---

## 3. Phase 1 — HPM foundation (quantity conversion) ☐ TO DO

TSW plans **bulk hydrocarbon quantities** that convert by temperature/density. Without HPM the nominations/SPW carry only a base unit and lose the oil dimension. Configure the minimum:

| Step | IMG path (SPRO → Industry Solution Oil & Gas (Downstream) → HPM) | Object/table | Trial value |
|---|---|---|---|
| 3.1 | HPM → Quantity Conversion → **Define UoM group** | `OIB…` UoM group | e.g. `ZOIL` (base **L15** litres @15 °C, **KG** mass, **M3**) |
| 3.2 | HPM → Quantity Conversion → **Conversion group / calc. base** (ASTM) | conversion group | assign density base + ASTM table |
| 3.3 | HPM → **Assign UoM group** to material type / used on materials | — | link `ZOIL` to the oil material type |

> HPM is the deepest part. For a *first look* you can create simple bulk materials in litres and add HPM conversion later; but the "wow" of TSW (temperature-corrected volumes) needs 3.1–3.2.

---

## 4. Phase 2 — Oil materials (master data) ☐ TO DO — **cockpit / GUI**

Bulk oil products the nominations will move. **Headless BAPI creation is blocked on this box** (the same material field-reference constraint that affected the retail articles), so create these via **MM01 / the Migration Cockpit "Migrate Your Data → Product"**.

**Recommended trial materials** (base UoM litres, oil material views + HPM UoM group `ZOIL`):
| Material | Description | Type |
|---|---|---|
| `OIL_ULSD` | Ultra-Low-Sulphur Diesel | bulk |
| `OIL_MOGAS` | Motor Gasoline (95) | bulk |

**Per-material steps (MM01):** basic data + UoM group → extend to the oil plants (**OGNT/OANT** or **OCPT/OJHB**) and the tank storage locations (`…Q`/`…T`) → Accounting/Costing (valuation) → oil-specific views (HPM).

**Verification:**
```sql
SELECT matnr, mtart, meins FROM mara WHERE matnr LIKE 'OIL_%';
SELECT matnr, werks FROM marc WHERE matnr LIKE 'OIL_%';       -- plant extension present
```

---

## 5. Phase 3 — TSW basic settings + number ranges ☐ TO DO

SPRO → Industry Solution Oil & Gas (Downstream) → **TSW (Trader's and Scheduler's Workbench)**.

### 5.1 Number ranges (SNRO) — do first
| NR object | Tx | Trial interval |
|---|---|---|
| `OIJNOM` (nominations) | `SNRO` → OIJNOM | `01` = `0000000001`–`0999999999` |
| `OIK37` (tickets) | `SNRO` → OIK37 | `01` = `0000000001`–`0999999999` |
| `OIJPEG` (pegging) | `SNRO` → OIJPEG | `01` (default) |
| `OIJ_VERS` (SPW versions) | `SNRO` → OIJ_VERS | `01` (default) |

> Number-range intervals are **client-local and not transported** — set them directly in each system with SNRO.

### 5.2 Modes of transport relevant to TSW → table `OIJTSWMOT` ✅ DONE (A4H)
Standard modes on this box: **01 Road · 02 Rail · 03 Sea · 04 Inland Waterway · 05 Air · 06 Postal**.
**01 Road, 02 Rail, 03 Sea, 04 Inland Waterway** written as TSW-relevant (direct write, untransported).

**Verification:** `SELECT vktra FROM oijtswmot;` → 01, 02, 03, 04

### 5.3 Location types → table `OIJLOCT` (fields: `LOCTYP, PLANIND, REFIND, ODINDO, ODINDD`) ✅ DONE (A4H)
Written (direct, untransported): **`TERM`** terminal (planning + origin + destination) and **`DEPO`** depot (planning + destination).
| LOCTYP | Meaning | PLANIND (planning) | REFIND (refinery) | ODINDO (origin) | ODINDD (dest.) |
|---|---|---|---|---|---|
| `TERM` | Terminal / import berth | X | – | X | X |
| `DEPO` | Inland depot | X | – | – | X |

**Verification:** `SELECT * FROM oijloct;`

---

## 6. Phase 4 — TSW locations ☐ TO DO — **RAP/Fiori app + dialog, NOT raw table writes**

> **Important data-model note (verified on A4H).** A TSW "location" is **not** just a flag on a plant. The object chain is:
> **Transport System** (`OIJTS`, the core network object — **plant is linked here**, see structure `OIJ09_S_WERKS` "Transport System – Plant") → **Location** (`OIJLOC`, an abstract node with `LOCID`, capacities/rates, and **schema** references `SCHEMA_BUSCONF/TECHSCH/ALLOC`) → **location↔transport-system assignment** (`OIJTSLOC`).
> `OIJTS` and `OIJTSLOC` are **RAP-managed** (draft tables `OIJTS_D`, `OIJTSLOC_D`; entities `R_OIL_TRANSPORTSYSTEMTP`, `R_OIL_TRANSPTSYSTLOCASSGMTT`) — maintain them in the **TSW app / IMG dialog**, never by direct table write (that bypasses the RAP logic and produces a non-functional shell).

| Step | Where | Object / table | Notes |
|---|---|---|---|
| 6.1 | TSW → Location → **Define Transport System** | `OIJTS` (+ `OIJTS_EXT` modes of transport) | create e.g. `ZTS_ZA`, link to plant **OCPT/OJHB**; `ZTS_BE` → **OGNT/OANT** |
| 6.2 | TSW → Location → **Define Locations** | `OIJLOC` | one `LOCID` per plant/tank; assign `LOCTYP` `TERM`/`DEPO` (§5.3); set capacities from the tank slocs (`…Q`/`…T`) |
| 6.3 | TSW → Location → **Assign locations to transport system** | `OIJTSLOC` | attach the locations to `ZTS_ZA` / `ZTS_BE`; set origin/destination flags |
| 6.4 | TSW → Location → **Planning materials per TS / location** | `OIJTSMAT` / `OIJLOCMAT` | which oil materials are planned at each location |
| 6.5 | (optional) **Berths / capacities** | `OIJBERLOC`, `OIJLOC` rate/volume fields | tank max/min, berth scheduling |

**Verification:**
```sql
SELECT tsyst, locid FROM oijtsloc;          -- location ↔ transport-system assignments
SELECT locid, loctyp, locnam FROM oijloc;   -- locations
```

---

## 7. Phase 5 — Nominations ☐ TO DO

The planned bulk movement. SPRO → TSW → **Nomination**.

| Step | Config object / table | Trial value |
|---|---|---|
| 7.1 Nomination **schema** | `OIJSCHEMA` (+ `OIJSCHEMA_T`) | `ZN01` "Trial nomination schema" |
| 7.2 **Movement scenario** (nomination line → goods movement) | `OIJ07_IF_MOVSCN` / movement-scenario IMG | stock-transfer scenario between two plants |
| 7.3 Nomination **type** + item categories + status | nomination-type config under the schema | `ZN` transfer nomination, assign NR `OIJNOM 01` |
| 7.4 Assign schema/type to locations | — | attach `ZN01` to `TERM`/`DEPO` |

> 7.1–7.3 are the interdependent core — maintain in the IMG dialogs so the schema→scenario→type links validate.

---

## 8. Phase 6 — Ticketing ☐ TO DO

Actualizes the physical movement and posts the goods movement. SPRO → TSW → **Ticket**.

| Step | Config object | Trial value |
|---|---|---|
| 8.1 **Ticket type** (load / discharge) | ticket-type config, NR `OIK37 01` | `ZL` load, `ZD` discharge |
| 8.2 **Actualization** rules | ticket → movement-type mapping | post to the movement scenario from §7.2 |
| 8.3 Assign ticket types to nomination item categories | — | `ZL/ZD` ↔ `ZN` |

---

## 9. Phase 7 — Stock Projection Worksheet ☐ TO DO

The projected stock view over time. SPRO → TSW → **Stock Projection Worksheet**.

| Step | Config object / table | Trial value |
|---|---|---|
| 9.1 **Forecast profile** | `OIJFCPRF` (+ `OIJFCPRFT`) | `ZSPW` |
| 9.2 Worksheet **layout / key figures** | SPW layout config | opening stock, receipts, issues, projected balance |
| 9.3 **What-if version** | NR `OIJ_VERS` | base version `V1` |
| 9.4 Confirm **HANA SPW engine** active | — | generation via `O4TCN_HDB` |

---

## 10. Phase 8 — Trial scenario (replayable end-to-end)

Once §3–§9 are in place, run this to prove TSW works. All interactive transactions.

1. **Create a nomination** — `O4T0`: move e.g. **500,000 L** of `OIL_ULSD` from **OCPT** (Cape Town terminal, tank `641Q`) → **OJHB** (Johannesburg depot, tank `641T`) on a chosen date, nomination type `ZN`.
2. **Stock Projection Worksheet** — `O4TB`: confirm projected stock **drops at OCPT** and **rises at OJHB** on the nomination date. (Generate via `O4TC` / `O4TCN_HDB`.)
3. **Enter a ticket** — `O4TE`: discharge ticket `ZD` against the nomination to actualize the physical movement → posts the goods movement.
4. **Re-run `O4TB`**: projected vs. actual reconciles after the ticket.
5. *(optional)* `O4T3WP` three-way pegging; `O4S0` TD transport view.

**Expected result:** the nomination appears in the workbench, the SPW shows the planned quantity shifting between the two locations on the date, and the ticket converts plan → actual with a material document.

---

## 11. Status tracker

| # | Item | Status |
|---|---|---|
| **0a** | **Activate BF `OIL_REVENUE_ACCOUNTING` (SFW5)** — REQUIRED FIRST | ☐ TO DO — currently INACTIVE |
| 0b | 4 oil plants (OGNT/OANT/OCPT/OJHB) | ✅ DONE (A4H) |
| 1 | HPM UoM / quantity-conversion group | ☐ TO DO |
| 2 | Oil materials (cockpit) | ☐ TO DO |
| 3 | Number ranges (OIJNOM, OIK37, OIJPEG, OIJ_VERS) | ☐ TO DO |
| 4 | TSW modes of transport (`OIJTSWMOT`) — 01/02/03/04 | ✅ DONE (A4H) — direct write, untransported |
| 5 | TSW location types (`OIJLOCT`) — TERM, DEPO | ✅ DONE (A4H) — direct write, untransported |
| 6 | TSW locations (Transport System `OIJTS` → `OIJLOC` → `OIJTSLOC`) | ☐ TO DO — RAP/Fiori app + dialog (not headless) |
| 7 | Nomination schema / scenario / type | ☐ TO DO |
| 8 | Ticket types + actualization | ☐ TO DO |
| 9 | SPW forecast profile + layout | ☐ TO DO |
| 10 | Trial run (nomination → SPW → ticket) | ☐ TO DO |

---

## 12. Appendix — one-shot verification queries

```sql
-- Oil plants + company code + tanks
SELECT werks, name1, ort01, land1, vlfkz FROM t001w WHERE werks IN ('OGNT','OANT','OCPT','OJHB');
SELECT bwkey, bukrs FROM t001k WHERE bwkey IN ('OGNT','OANT','OCPT','OJHB');
SELECT werks, lgort, lgobe FROM t001l WHERE werks IN ('OGNT','OANT','OCPT','OJHB') ORDER BY werks, lgort;

-- TSW config progress (all start at 0 on greenfield)
SELECT COUNT(*) FROM oijtswmot;   -- modes of transport
SELECT COUNT(*) FROM oijloct;     -- location types
SELECT COUNT(*) FROM oijschema;   -- nomination schema
SELECT COUNT(*) FROM oijfcprf;    -- SPW forecast profile

-- Oil materials
SELECT matnr, mtart, meins FROM mara WHERE matnr LIKE 'OIL_%';
SELECT matnr, werks FROM marc WHERE matnr LIKE 'OIL_%';

-- Number-range intervals
--   SNRO → OIJNOM / OIK37 / OIJPEG / OIJ_VERS  (intervals are client-local, not in a transport)
```
