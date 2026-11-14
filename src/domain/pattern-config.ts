/**
 * Regional configuration for pattern flags (src/domain/patterns.ts). Plain data so it can be extended without touching
 * the scoring rules. Every match from these lists is reported with its evidence label; none of them is a certainty.
 */

/**
 * Scheduled passenger/cargo airline ICAO designators commonly seen over central Indiana. A callsign of the form
 * <designator><flight number> from these operators is a published scheduled or cargo operation (Observed callsign).
 */
export const SCHEDULED_OPERATORS: Readonly<Record<string, string>> = {
  AAL: "American Airlines", ACA: "Air Canada", AFR: "Air France", AMX: "Aeroméxico", ASA: "Alaska Airlines", ASH: "Mesa Airlines",
  AAY: "Allegiant Air", AWI: "Air Wisconsin", BAW: "British Airways", DAL: "Delta Air Lines", DLH: "Lufthansa", EDV: "Endeavor Air",
  ENY: "Envoy Air", FFT: "Frontier Airlines", GJS: "GoJet Airlines", JBU: "JetBlue", JIA: "PSA Airlines", JZA: "Jazz Aviation",
  MXY: "Breeze Airways", NKS: "Spirit Airlines", PDT: "Piedmont Airlines", QXE: "Horizon Air", RPA: "Republic Airways",
  SCX: "Sun Country", SKW: "SkyWest Airlines", SWA: "Southwest Airlines", UAL: "United Airlines",
  ABX: "ABX Air (cargo)", ATN: "Air Transport International (cargo)", FDX: "FedEx (cargo)", GTI: "Atlas Air (cargo)", UPS: "UPS (cargo)",
};

/** Fractional-ownership and large charter jet operators. */
export const CHARTER_OPERATORS: Readonly<Record<string, string>> = {
  EJA: "NetJets", LXJ: "Flexjet", XSR: "Executive AirShare", JTL: "Jet Linx", FLE: "Flair Jets",
};

export type TrainingFleet = {
  label: string;
  /** ICAO telephony designator used as the callsign prefix (e.g. "PDU" for PDU56). */
  callsignDesignator?: string;
  /** Registration pattern of the fleet's N-numbers. Patterns can collide with unrelated aircraft (Supported inference). */
  registration?: RegExp;
  /** FAA registrant name pattern (business / government registrants only; individuals are redacted). */
  owner?: RegExp;
};

/** Local flight-training fleets. Extend for your area. */
export const TRAINING_FLEETS: readonly TrainingFleet[] = [
  { label: "LIFT Academy training fleet (Indianapolis Intl)", callsignDesignator: "LTA", owner: /\bLIFT AIRCRAFT\b/ },
  { label: "Vincennes University flight-training fleet", registration: /^N\d{1,3}VU$/, owner: /\bVINCENNES UNIVERSITY\b/ },
  { label: "Purdue University flight-training fleet (Lafayette)", callsignDesignator: "PDU", registration: /^N\d{1,3}PU$/, owner: /\bPURDUE (UNIVERSITY|AVIATION|PILOTS)\b|\bTRUSTEES OF PURDUE\b/ },
  { label: "Indiana State University flight-training fleet (Terre Haute)", callsignDesignator: "ISU", owner: /\bINDIANA STATE UNIVERSITY\b/ },
  { label: "ATP Flight School training fleet", callsignDesignator: "CXK", owner: /^(ATP AIRCRAFT|CAREER TRACK)\b/ },
  { label: "Tom Wood Aviation / Textron Cessna 172 training fleet", registration: /^N\d{1,3}TW$/, owner: /\bTOM WOOD AVIATION\b/ },
  { label: "BOLDFlight flight-training fleet (Greenwood / Danville)", owner: /\bBOLD ?FLIGHT\b|\bBOLD AVIATION\b/ },
];

/** FAA "government" registrants that are schools rather than agencies (public universities are government-registered). */
export const EDUCATION_OWNER = /\b(UNIVERSITY|COLLEGE|SCHOOL|ACADEMY|TRUSTEES)\b/;

export type KnownAirport = { id: string; latitude: number; longitude: number; elevationFt: number };

/**
 * Airports whose traffic patterns, practice approaches and holds explain low circling nearby. Coordinates and field
 * elevations are approximate (within ~0.5 NM / 50 ft); the rule uses a 3 NM radius. Extend for your area.
 */
export const KNOWN_AIRPORTS: readonly KnownAirport[] = [
  { id: "KIND", latitude: 39.7173, longitude: -86.2944, elevationFt: 797 },
  { id: "KEYE", latitude: 39.8251, longitude: -86.2958, elevationFt: 823 },
  { id: "KTYQ", latitude: 40.0306, longitude: -86.2514, elevationFt: 922 },
  { id: "KUMP", latitude: 39.9353, longitude: -86.0451, elevationFt: 811 },
  { id: "KMQJ", latitude: 39.8434, longitude: -85.8971, elevationFt: 862 },
  { id: "KHFY", latitude: 39.6313, longitude: -86.0881, elevationFt: 822 },
  { id: "KLAF", latitude: 40.4123, longitude: -86.9369, elevationFt: 606 },
  { id: "KHUF", latitude: 39.4515, longitude: -87.3076, elevationFt: 589 },
  { id: "KBMG", latitude: 39.146, longitude: -86.6167, elevationFt: 846 },
  { id: "KAID", latitude: 40.1086, longitude: -85.6129, elevationFt: 919 },
  { id: "KMIE", latitude: 40.2423, longitude: -85.3958, elevationFt: 937 },
  { id: "KBAK", latitude: 39.2619, longitude: -85.8963, elevationFt: 656 },
  { id: "KGEZ", latitude: 39.5831, longitude: -85.8045, elevationFt: 803 },
  { id: "KOKK", latitude: 40.5282, longitude: -86.059, elevationFt: 830 },
  { id: "KFWA", latitude: 40.9785, longitude: -85.1951, elevationFt: 815 },
  { id: "KSBN", latitude: 41.7087, longitude: -86.3173, elevationFt: 799 },
  { id: "KEVV", latitude: 38.037, longitude: -87.5324, elevationFt: 418 },
  // Hendricks County-Gordon Graham Field, Danville (FAA 2R2; field elevation 897.8 ft, runway 18/36).
  { id: "2R2", latitude: 39.7467, longitude: -86.4753, elevationFt: 898 },
  // Putnam County Regional, Greencastle (FAA GPC, formerly 4I7; field elevation 842 ft, runway 18/36).
  { id: "KGPC", latitude: 39.6336, longitude: -86.8138, elevationFt: 842 },
];

/**
 * Private and small airstrips near the user. A dip within `airstripNm` of one scores 0.5 instead of the full close-dip
 * weight (a touch-and-go or low pass there looks exactly like a dip), and a low point within ~100 ft of the strip's
 * elevation is read as a touch-and-go (0). Add only entries checked against FAA data (FAA ID, coordinates, elevation).
 * Intentionally empty until verified; public fields in KNOWN_AIRPORTS are checked the same way.
 */
export const KNOWN_AIRSTRIPS: readonly KnownAirport[] = [];

/** Time zone used to count "days" for recurrence and control comparison. */
export const PATTERN_TIME_ZONE = "America/Indianapolis";
