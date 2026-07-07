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

TSW plans **bulk hydrocarbon quantities** that convert by temperature/density. Without HPM the nominations/SPW carry only a base unit and lose the oil dimension. Configure the minimum — **real IMG activities on A4H** (found via `img_search`; run each with its tcode or via SPRO):

| Step | IMG activity | Title | Object → maint. | Tcode |
|---|---|---|---|---|
| 3.1 | **`SIMG_HPM_0002`** | Define QCI Parameters | `VC_OIB07` → CDAT | SM34 |
| 3.2 | **`SIMG_HPM_0001`** | Define Conversion Group and External Function | `VC_OIB_CONVGROUP` → CDAT | SM34 |
| 3.3 | **`SIMG_HPM_0003`** | Define Conversion Mode | `V_OIB02` → VDAT | **O581** |
| 3.4 | **`SIMG_HPM_0011`** | Define Additional Stockkeeping UoMs (**the UoM group**) | `VC_OIB_UOMGROUP` → CDAT | SM34 |
| 3.5 | **`SIMG_HPM_0012`** | Select QCI Default Table | `V_OIB_DEF` → VDAT | SM30 |
| 3.6 | **`SIMG_HPM_0019`** | Define Settings for Goods Movements (MIGO) | `V_OIB_MIGO_DEF` → VDAT | SM30 |
| check | **`SIMG_HPM_0006`** / **`SIMG_HPM_0007`** | Oil & Gas Quantity Calculator / check conversion | — | **O3QCITEST** / **O3D0** |

**Trial values:** UoM group `ZOIL` (base **L15** litres @15 °C + **KG** mass + **M3**), conversion group with a density/ASTM base, QCI parameters for the products. Tank-level (silo) analysis is `SIMG_HPM_SILO_*` — e.g. **`SIMG_HPM_SILO_0003`** *Define storage location as storage location for silo* (`V_OII_T001L_SILO`, tcode **O5_SILO02**) turns the `…Q`/`…T` tanks into silo-managed storage.

> HPM is the deepest part. For a *first look* you can create simple bulk materials in litres and add conversion later; the "wow" (temperature-corrected volumes) needs 3.1–3.4.

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

SPRO → Industry Solution Oil & Gas (Downstream) → **TSW**. Grounded IMG activities on A4H:

### 5.1 Global control + master-data settings
| IMG activity | Title | Object → maint. | Tcode |
|---|---|---|---|
| **`SIMG_TSW_0023`** | Specify TSW control parameters | `V_TOIJX_01` → VDAT | SM30 |
| **`SIMG_OIJ_TSW_13`** | Specify TSW master data settings | `V_TOIJX_04` → VDAT | SM30 |
| **`SIMG_TSW_0001`** | Set import/export flag | `V_OIJIMEX` → VDAT | SM30 |
| **`SIMG_OIJ_TSW_012`** | Define master data event types | `V_TOI0EV` → VDAT | SM30 |

### 5.2 Number ranges (client-local — set in each system)
| IMG activity | For | NR object | Tcode |
|---|---|---|---|
| **`SIMG_TSW_0021`** | Nominations | `OIJNOM` | **O5TNR_OIJ_NOM** |
| **`SIMG_OIJ_TSW_0003`** | Tickets | `OIK37` | **O5V1** |
| **`SIMG_OIJ_TSW_038`** | Nomination versions (SPW what-if) | `OIJ_VERS` | **O5TNR_NOM_VERS** |
| **`SIMG_TSW_0022`** | Worklists | — | **O5T1** |
| **`SIMG_OIJ_TSW_059`** | Berth IDs (optional) | — | **O4BER** |
| **`SIMG_OIJ_TSW_071`** | Nomination communication (optional) | — | **O5TNR_NOM_COMM** |

> Trial: interval `01` = `0000000001`–`0999999999` for nominations and tickets. Number-range intervals are **not transported**.

### 5.3 Modes of transport for TSW ✅ DONE (A4H)
IMG **`SIMG_TSW_0024`** *Define mode of transport for rack issues* → `V_TOIJRMOT` (table `OIJTSWMOT`). Written: **01 Road, 02 Rail, 03 Sea, 04 Inland Waterway** (direct, untransported). Related: **`SIMG_TSW_0003`** *Assign TSW flag to mode of transport* → `V_OIJTVTR`; **`SIMG_TSW_0025`** *movement type for rack issues* → `V_TOIJRMVTY`.
**Verification:** `SELECT vktra FROM oijtswmot;` → 01, 02, 03, 04

### 5.4 Location types → `OIJLOCT` ✅ DONE (A4H)
Written (direct): **`TERM`** terminal (planning + origin + destination), **`DEPO`** depot (planning + destination). Usage indicators per location/source = IMG **`SIMG_OIJ_TSW_062`** → `TOIJUSAGE`.
| LOCTYP | Meaning | PLANIND | REFIND | ODINDO | ODINDD |
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
| 6.6 | **Transfers between transport systems** — IMG **`SIMG_OIJ_TSW_064`** | `TOIJ_LB_SET` → TABU (SM30) | parameters for location-balancing transfers |

> Confirmed via `img_search`: there is **no classic IMG maintenance activity** for the transport-system / location *master* — it is the RAP app (`O4S1` / Fiori). The only IMG activity in this area is the transfer-parameters table above (`SIMG_OIJ_TSW_064`).

**Verification:**
```sql
SELECT tsyst, locid FROM oijtsloc;          -- location ↔ transport-system assignments
SELECT locid, loctyp, locnam FROM oijloc;   -- locations
```

---

## 7. Phase 5 — Nominations ☐ TO DO

The planned bulk movement. Grounded IMG activities (maintain in order — the movement-scenario → nomination-type → status links validate against each other):

| Step | IMG activity | Title | Object → maint. |
|---|---|---|---|
| 7.1 | **`SIMG_OIJ_TSW_0008`** | Customize TSW **movement scenarios** (nomination line → goods movement) | `V_TOIJ_EL_MVSCEN` → VDAT |
| 7.2 | **`SIMG_OIJ_TSW_0010`** | Define **posting groups** for movement scenarios | `V_TOIJ_EL_MS_GRP` → VDAT |
| 7.3 | **`SIMG_OIJ_TSW_0007`** | Define **schedule item types** | `V_TOIJ_EL_SITYPE` → VDAT |
| 7.4 | **`SIMG_OIJ_TSW_002`** | Define **nomination types** | `V_OIJNOMTYP` → VDAT |
| 7.5 | **`SIMG_OIJ_TSW_004`** | Define **status codes** | `V_OIJNOM_ST01` → VDAT |
| 7.6 | **`SIMG_OIJ_TSW_005`** | Define **status profiles** and dependencies | `VC_OIJNOMST` → CDAT (SM34) |
| 7.7 | **`SIMG_OIJ_TSW_0009`** | Define **nomination relevance** | `VC_OI0_NOM_REL` → CDAT (SM34) |
| 7.8 | **`SIMG_OIJ_TSW_040`** | Define **nomination views** (UI) | `VC_OIJ_NOM_VIEW` → CDAT (SM34) |

**Trial:** movement scenario = stock transfer between two plants; nomination type `ZN` (transfer), NR object `OIJNOM`.

> 7.1–7.6 are the interdependent core — maintain in the IMG dialogs (do **not** raw-write these greenfield tables).

---

## 8. Phase 6 — Ticketing ☐ TO DO

Actualizes the physical movement and posts the goods movement.

| Step | IMG activity | Title | Object → maint. |
|---|---|---|---|
| 8.1 | **`SIMG_OIJ_TSW_049`** | Maintain **ticket types** | `V_OIJ_TKT_TYPE` → VDAT |
| 8.2 | **`SIMG_OIJ_TSW_050`** | Define **measuring method** for ticket quantities | `V_OIJ_TKT_QMM` → VDAT |
| 8.3 | **`SIMG_OIJ_TSW_0049`** | Define **validation groups** for ticketing | `VC_OIJ_TKT_CHK` → CDAT (SM34) |
| 8.4 | **`SIMG_TSW_0005`** | Define **ticket number rules** | `V_OIJHTNR` → VDAT |
| 8.5 | **`SIMG_OIJ_TSW_1117`** | Assign **output determination** procedure | `V_OIJ_TKT_TYPE_H/_I` → VDAT |

**Trial:** ticket types `ZL` load / `ZD` discharge, NR object `OIK37`; ticket posts to the movement scenario from §7.1.

---

## 9. Phase 7 — Stock Projection Worksheet ☐ TO DO

The projected stock view over time.

| Step | IMG activity | Title | Object → maint. |
|---|---|---|---|
| 9.1 | **`SIMG_OIJ_TSW_0001`** | Specify **parameters for stock projection** | `V_TOIJX_02` → VDAT |
| 9.2 | **`SIMG_OIJ_TSW_018`** | Specify **stock projection relevance** | `V_OIJ_SPREL` → VDAT |
| 9.3 | **`SIMG_OIJ_TSW_019`** | Define **stock projection types** (what-if) | `V_OIJ_SPTYPES` → VDAT |
| 9.4 | **`SIMG_OIJ_TSW_020`** | Define **time buckets** | `V_OIJ_TIMEBUCKET` → VDAT |
| 9.5 | **`SIMG_OIJ_TSW_0002`** | Maintain **forecast profile** for rack issue | `V_OIJFCPRF` → VDAT |
| 9.6 | **`SIMG_OIJ_TSW_0004`** | Define profile for **target stock coverage** | `V_OIJTGTCOV` → VDAT |
| 9.7 | **`SIMG_TSW_0008`** | Define profile for **safety stock coverage** | `V_OIJCOV` → VDAT |

**Trial:** what-if version via NR `OIJ_VERS`; generate the worksheet on HANA via **`O4TCN_HDB`**.

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

---

## 13. Appendix — TSW / HPM IMG activity map (grounded on A4H)

Discovered via `img_search` (full CUS_IMGACT scan). **180+** TSW activities exist; this is the
build-relevant subset. To see the rest: `img_search keyword=TSW maxResults=400`, or per area
`img_search keyword=SIMG_HPM` / `SIMG_OIJ_TSW`. Every row is a real activity on this box.

**HPM (Hydrocarbon Product Management) — foundation**
| Activity | Title | Maint. object | Tcode |
|---|---|---|---|
| `SIMG_HPM_0001` | Conversion group + external function | `VC_OIB_CONVGROUP` | SM34 |
| `SIMG_HPM_0002` | QCI parameters | `VC_OIB07` | SM34 |
| `SIMG_HPM_0003` | Conversion mode | `V_OIB02` | O581 |
| `SIMG_HPM_0011` | Additional stockkeeping UoMs (**UoM group**) | `VC_OIB_UOMGROUP` | SM34 |
| `SIMG_HPM_0012` | Select QCI default table | `V_OIB_DEF` | SM30 |
| `SIMG_HPM_0019` | Settings for goods movements (MIGO) | `V_OIB_MIGO_DEF` | SM30 |
| `SIMG_HPM_SILO_0003` | Storage location as silo (tanks) | `V_OII_T001L_SILO` | O5_SILO02 |
| `SIMG_HPM_0006` / `_0007` | Quantity calculator / check conversion | — | O3QCITEST / O3D0 |

**TSW global + master data**
| Activity | Title | Maint. object | Tcode |
|---|---|---|---|
| `SIMG_TSW_0023` | TSW control parameters | `V_TOIJX_01` | SM30 |
| `SIMG_OIJ_TSW_13` | TSW master data settings | `V_TOIJX_04` | SM30 |
| `SIMG_TSW_0001` | Import/export flag | `V_OIJIMEX` | SM30 |
| `SIMG_TSW_0024` | Mode of transport for rack issues ✅ | `V_TOIJRMOT` (`OIJTSWMOT`) | SM30 |
| `SIMG_TSW_0003` | Assign TSW flag to mode of transport | `V_OIJTVTR` | SM30 |
| `SIMG_TSW_0025` | Movement type for rack issues | `V_TOIJRMVTY` | SM30 |
| `SIMG_OIJ_TSW_062` | Usage indicators for location/source | `TOIJUSAGE` | SM30 |
| `SIMG_TSW_0020` | Nomination + ticket retention time | `V_OIJARC` | SM30 |

**Number ranges**
| Activity | For | Object | Tcode |
|---|---|---|---|
| `SIMG_TSW_0021` | Nominations | `OIJNOM` | O5TNR_OIJ_NOM |
| `SIMG_OIJ_TSW_0003` | Tickets | `OIK37` | O5V1 |
| `SIMG_OIJ_TSW_038` | Nomination versions | `OIJ_VERS` | O5TNR_NOM_VERS |
| `SIMG_TSW_0022` | Worklists | — | O5T1 |
| `SIMG_OIJ_TSW_059` | Berth IDs | — | O4BER |

**Nominations**
| Activity | Title | Maint. object |
|---|---|---|
| `SIMG_OIJ_TSW_0008` | Movement scenarios | `V_TOIJ_EL_MVSCEN` |
| `SIMG_OIJ_TSW_0010` | Posting groups for movement scenarios | `V_TOIJ_EL_MS_GRP` |
| `SIMG_OIJ_TSW_0007` | Schedule item types | `V_TOIJ_EL_SITYPE` |
| `SIMG_OIJ_TSW_002` | Nomination types | `V_OIJNOMTYP` |
| `SIMG_OIJ_TSW_004` | Status codes | `V_OIJNOM_ST01` |
| `SIMG_OIJ_TSW_005` | Status profiles + dependencies | `VC_OIJNOMST` (SM34) |
| `SIMG_OIJ_TSW_0009` | Nomination relevance | `VC_OI0_NOM_REL` (SM34) |
| `SIMG_OIJ_TSW_040` | Nomination views (UI) | `VC_OIJ_NOM_VIEW` (SM34) |

**Tickets**
| Activity | Title | Maint. object |
|---|---|---|
| `SIMG_OIJ_TSW_049` | Ticket types | `V_OIJ_TKT_TYPE` |
| `SIMG_OIJ_TSW_050` | Measuring method for ticket quantities | `V_OIJ_TKT_QMM` |
| `SIMG_OIJ_TSW_0049` | Validation groups for ticketing | `VC_OIJ_TKT_CHK` (SM34) |
| `SIMG_TSW_0005` | Ticket number rules | `V_OIJHTNR` |
| `SIMG_OIJ_TSW_1117` | Assign output determination procedure | `V_OIJ_TKT_TYPE_H/_I` |

**Stock Projection Worksheet (SPW)**
| Activity | Title | Maint. object |
|---|---|---|
| `SIMG_OIJ_TSW_0001` | Parameters for stock projection | `V_TOIJX_02` |
| `SIMG_OIJ_TSW_018` | Stock projection relevance | `V_OIJ_SPREL` |
| `SIMG_OIJ_TSW_019` | Stock projection types (what-if) | `V_OIJ_SPTYPES` |
| `SIMG_OIJ_TSW_020` | Time buckets | `V_OIJ_TIMEBUCKET` |
| `SIMG_OIJ_TSW_0002` | Forecast profile for rack issue | `V_OIJFCPRF` |
| `SIMG_OIJ_TSW_0004` | Target stock coverage profile | `V_OIJTGTCOV` |
| `SIMG_TSW_0008` | Safety stock coverage profile | `V_OIJCOV` |

**Three-way pegging (optional)**
| Activity | Title | Maint. object | Tcode |
|---|---|---|---|
| `SIMG_OIJ_TSW_053` | Parameters for pegging stock | `V_TOIJX_06` | SM30 |
| `SIMG_OIJ_TSW_055` | Pegging type | `V_OIJ_PEGT_CHK_A` | O5TPEGT |
| `SIMG_OIJ_TSW_054` | Global setting for LateLocking in 3WP | `V_TOIJX_09` | SM30 |
