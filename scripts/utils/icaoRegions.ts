import type { HazardDomain, HazardRegion } from "../../src/types/schema.ts";

export interface AuthorityMetadata {
  issuer: string;
  country: string;
  region: HazardRegion;
}

const ICAO_TWO_LETTER_MAP: Record<string, AuthorityMetadata> = {
  // Europe (E* & L* & B* & U*)
  EG: { issuer: "UK CAA / NATS", country: "United Kingdom", region: "Europe" },
  EI: { issuer: "AirNav Ireland", country: "Ireland", region: "Europe" },
  EH: { issuer: "LVNL Netherlands", country: "Netherlands", region: "Europe" },
  EB: { issuer: "skeyes Belgium", country: "Belgium", region: "Europe" },
  EL: { issuer: "ANA Luxembourg", country: "Luxembourg", region: "Europe" },
  ED: { issuer: "DFS Germany", country: "Germany", region: "Europe" },
  ET: { issuer: "DFS / Mil Germany", country: "Germany", region: "Europe" },
  EK: { issuer: "Naviair Denmark", country: "Denmark", region: "Europe" },
  EN: { issuer: "Avinor Norway", country: "Norway", region: "Europe" },
  ES: { issuer: "LFV Sweden", country: "Sweden", region: "Europe" },
  EF: { issuer: "Fintraffic ANS", country: "Finland", region: "Europe" },
  EE: { issuer: "EANS Estonia", country: "Estonia", region: "Europe" },
  EV: { issuer: "LGS Latvia", country: "Latvia", region: "Europe" },
  EY: { issuer: "Oro Navigacija", country: "Lithuania", region: "Europe" },
  EP: { issuer: "PANSA Poland", country: "Poland", region: "Europe" },
  BI: { issuer: "Isavia Iceland", country: "Iceland", region: "Europe" },
  BG: { issuer: "Naviair Greenland", country: "Greenland", region: "North America" },
  LF: { issuer: "DGAC France", country: "France", region: "Europe" },
  LS: { issuer: "Skyguide Switzerland", country: "Switzerland", region: "Europe" },
  LO: { issuer: "Austro Control", country: "Austria", region: "Europe" },
  LK: { issuer: "ANS Czechia", country: "Czechia", region: "Europe" },
  LZ: { issuer: "LPS Slovakia", country: "Slovakia", region: "Europe" },
  LH: { issuer: "HungaroControl", country: "Hungary", region: "Europe" },
  LJ: { issuer: "Slovenia Control", country: "Slovenia", region: "Europe" },
  LD: { issuer: "Croatia Control", country: "Croatia", region: "Europe" },
  LQ: { issuer: "BHANSA Bosnia", country: "Bosnia & Herzegovina", region: "Europe" },
  LY: { issuer: "SMATSA Serbia/MNE", country: "Serbia / Montenegro", region: "Europe" },
  LW: { issuer: "M-NAV North Macedonia", country: "North Macedonia", region: "Europe" },
  LA: { issuer: "Albcontrol Albania", country: "Albania", region: "Europe" },
  LR: { issuer: "ROMATSA Romania", country: "Romania", region: "Europe" },
  LB: { issuer: "BULATSA Bulgaria", country: "Bulgaria", region: "Europe" },
  LU: { issuer: "MOLDATSA Moldova", country: "Moldova", region: "Europe" },
  LG: { issuer: "HCAA Greece", country: "Greece", region: "Europe" },
  LC: { issuer: "DCAC Cyprus", country: "Cyprus", region: "Europe" },
  LT: { issuer: "DHMI Turkey", country: "Turkey", region: "Europe" },
  LI: { issuer: "ENAV Italy", country: "Italy", region: "Europe" },
  LM: { issuer: "MATS Malta", country: "Malta", region: "Europe" },
  LE: { issuer: "ENAIRE Spain", country: "Spain", region: "Europe" },
  GC: { issuer: "ENAIRE Canarias", country: "Spain", region: "Europe" },
  LP: { issuer: "NAV Portugal", country: "Portugal", region: "Europe" },
  UK: { issuer: "UkSATSE Ukraine", country: "Ukraine", region: "Europe" },
  UM: { issuer: "Belaeronavigatsia", country: "Belarus", region: "Europe" },
  UG: { issuer: "Sakaeronavigatsia", country: "Georgia", region: "Europe" },
  UD: { issuer: "ARMATS Armenia", country: "Armenia", region: "Europe" },
  UB: { issuer: "AZANS Azerbaijan", country: "Azerbaijan", region: "Europe" },
  UU: { issuer: "Rosaviatsia", country: "Russia", region: "Europe" },
  UL: { issuer: "Rosaviatsia", country: "Russia", region: "Europe" },
  UR: { issuer: "Rosaviatsia", country: "Russia", region: "Europe" },
  UW: { issuer: "Rosaviatsia", country: "Russia", region: "Europe" },
  US: { issuer: "Rosaviatsia", country: "Russia", region: "Asia" },
  UN: { issuer: "Rosaviatsia", country: "Russia", region: "Asia" },
  UE: { issuer: "Rosaviatsia", country: "Russia", region: "Asia" },
  UH: { issuer: "Rosaviatsia", country: "Russia", region: "Asia" },
  UI: { issuer: "Rosaviatsia", country: "Russia", region: "Asia" },

  // Middle East (O* & LL*)
  LL: { issuer: "IAA Israel", country: "Israel", region: "Middle East" },
  OJ: { issuer: "CARC Jordan", country: "Jordan", region: "Middle East" },
  OL: { issuer: "DGCA Lebanon", country: "Lebanon", region: "Middle East" },
  OS: { issuer: "SCAA Syria", country: "Syria", region: "Middle East" },
  OR: { issuer: "ICAA Iraq", country: "Iraq", region: "Middle East" },
  OI: { issuer: "CAO Iran", country: "Iran", region: "Middle East" },
  OM: { issuer: "GCAA UAE", country: "United Arab Emirates", region: "Middle East" },
  OE: { issuer: "GACA Saudi Arabia", country: "Saudi Arabia", region: "Middle East" },
  OT: { issuer: "QCAA Qatar", country: "Qatar", region: "Middle East" },
  OB: { issuer: "MTT Bahrain", country: "Bahrain", region: "Middle East" },
  OO: { issuer: "CAA Oman", country: "Oman", region: "Middle East" },
  OK: { issuer: "DGCA Kuwait", country: "Kuwait", region: "Middle East" },
  OY: { issuer: "CAMA Yemen", country: "Yemen", region: "Middle East" },

  // Africa (D*, F*, G*, H*)
  HE: { issuer: "ECAA Egypt", country: "Egypt", region: "Africa" },
  HL: { issuer: "LCAA Libya", country: "Libya", region: "Africa" },
  DT: { issuer: "OACA Tunisia", country: "Tunisia", region: "Africa" },
  DA: { issuer: "ENNA Algeria", country: "Algeria", region: "Africa" },
  GM: { issuer: "ONDA Morocco", country: "Morocco", region: "Africa" },
  GO: { issuer: "ASECNA Senegal", country: "Senegal", region: "Africa" },
  GV: { issuer: "ASA Cabo Verde", country: "Cabo Verde", region: "Africa" },
  DI: { issuer: "ASECNA Côte d'Ivoire", country: "Côte d'Ivoire", region: "Africa" },
  DG: { issuer: "GCAA Ghana", country: "Ghana", region: "Africa" },
  DN: { issuer: "NAMA Nigeria", country: "Nigeria", region: "Africa" },
  FK: { issuer: "ASECNA Cameroon", country: "Cameroon", region: "Africa" },
  FC: { issuer: "ASECNA Congo", country: "Congo", region: "Africa" },
  FZ: { issuer: "RVA DR Congo", country: "DR Congo", region: "Africa" },
  FN: { issuer: "ENANA Angola", country: "Angola", region: "Africa" },
  HS: { issuer: "SCAA Sudan", country: "Sudan", region: "Africa" },
  HA: { issuer: "ECAA Ethiopia", country: "Ethiopia", region: "Africa" },
  HK: { issuer: "KCAA Kenya", country: "Kenya", region: "Africa" },
  HU: { issuer: "UCAA Uganda", country: "Uganda", region: "Africa" },
  HT: { issuer: "TCAA Tanzania", country: "Tanzania", region: "Africa" },
  HR: { issuer: "RCAA Rwanda", country: "Rwanda", region: "Africa" },
  FL: { issuer: "ZACL Zambia", country: "Zambia", region: "Africa" },
  FV: { issuer: "CAAZ Zimbabwe", country: "Zimbabwe", region: "Africa" },
  FQ: { issuer: "ADM Mozambique", country: "Mozambique", region: "Africa" },
  FB: { issuer: "CAAB Botswana", country: "Botswana", region: "Africa" },
  FY: { issuer: "NCAA Namibia", country: "Namibia", region: "Africa" },
  FA: { issuer: "ATNS South Africa", country: "South Africa", region: "Africa" },
  FM: { issuer: "ASECNA Madagascar", country: "Madagascar", region: "Africa" },
  FI: { issuer: "DCA Mauritius", country: "Mauritius", region: "Africa" },
  FS: { issuer: "SCAA Seychelles", country: "Seychelles", region: "Africa" },

  // Asia (O*, U*, V*, W*, R*, Z*)
  OA: { issuer: "ACAA Afghanistan", country: "Afghanistan", region: "Asia" },
  OP: { issuer: "PAA Pakistan", country: "Pakistan", region: "Asia" },
  UA: { issuer: "Kazaeronavigatsia", country: "Kazakhstan", region: "Asia" },
  UT: { issuer: "Uzaeronavigatsia", country: "Uzbekistan / Central Asia", region: "Asia" },
  UC: { issuer: "Kyrgyzaeronavigatsia", country: "Kyrgyzstan", region: "Asia" },
  VI: { issuer: "AAI India", country: "India", region: "Asia" },
  VA: { issuer: "AAI India", country: "India", region: "Asia" },
  VE: { issuer: "AAI India", country: "India", region: "Asia" },
  VO: { issuer: "AAI India", country: "India", region: "Asia" },
  VC: { issuer: "AAS Sri Lanka", country: "Sri Lanka", region: "Asia" },
  VG: { issuer: "CAAB Bangladesh", country: "Bangladesh", region: "Asia" },
  VN: { issuer: "CAAN Nepal", country: "Nepal", region: "Asia" },
  VR: { issuer: "MACL Maldives", country: "Maldives", region: "Asia" },
  VY: { issuer: "DCA Myanmar", country: "Myanmar", region: "Asia" },
  VT: { issuer: "AEROTHAI Thailand", country: "Thailand", region: "Asia" },
  VV: { issuer: "VATM Vietnam", country: "Vietnam", region: "Asia" },
  VL: { issuer: "LANS Laos", country: "Laos", region: "Asia" },
  VD: { issuer: "SSCA Cambodia", country: "Cambodia", region: "Asia" },
  WM: { issuer: "CAAM Malaysia", country: "Malaysia", region: "Asia" },
  WB: { issuer: "CAAM Malaysia", country: "Malaysia / Brunei", region: "Asia" },
  WS: { issuer: "CAAS Singapore", country: "Singapore", region: "Asia" },
  WI: { issuer: "AirNav Indonesia", country: "Indonesia", region: "Asia" },
  WA: { issuer: "AirNav Indonesia", country: "Indonesia", region: "Asia" },
  RP: { issuer: "CAAP Philippines", country: "Philippines", region: "Asia" },
  VH: { issuer: "CAD Hong Kong", country: "Hong Kong", region: "Asia" },
  VM: { issuer: "AACM Macau", country: "Macau", region: "Asia" },
  RC: { issuer: "CAA Taiwan", country: "Taiwan", region: "Asia" },
  RK: { issuer: "MOLIT South Korea", country: "South Korea", region: "Asia" },
  ZK: { issuer: "GACA DPRK", country: "North Korea", region: "Asia" },
  RJ: { issuer: "JCAB Japan", country: "Japan", region: "Asia" },
  RO: { issuer: "JCAB Japan", country: "Japan", region: "Asia" },
  ZM: { issuer: "MCAA Mongolia", country: "Mongolia", region: "Asia" },
  ZB: { issuer: "CAAC China", country: "China", region: "Asia" },
  ZS: { issuer: "CAAC China", country: "China", region: "Asia" },
  ZG: { issuer: "CAAC China", country: "China", region: "Asia" },
  ZP: { issuer: "CAAC China", country: "China", region: "Asia" },
  ZL: { issuer: "CAAC China", country: "China", region: "Asia" },
  ZY: { issuer: "CAAC China", country: "China", region: "Asia" },
  ZW: { issuer: "CAAC China", country: "China", region: "Asia" },
  ZJ: { issuer: "CAAC China", country: "China", region: "Asia" },
  ZU: { issuer: "CAAC China", country: "China", region: "Asia" },
  ZH: { issuer: "CAAC China", country: "China", region: "Asia" },

  // Oceania (Y*, N*, A*)
  YM: { issuer: "Airservices Australia", country: "Australia", region: "Oceania" },
  YB: { issuer: "Airservices Australia", country: "Australia", region: "Oceania" },
  YP: { issuer: "Airservices Australia", country: "Australia", region: "Oceania" },
  YS: { issuer: "Airservices Australia", country: "Australia", region: "Oceania" },
  NZ: { issuer: "Airways New Zealand", country: "New Zealand", region: "Oceania" },
  NF: { issuer: "Fiji Airports", country: "Fiji / Tonga", region: "Oceania" },
  NV: { issuer: "AVL Vanuatu", country: "Vanuatu", region: "Oceania" },
  NW: { issuer: "DAC New Caledonia", country: "New Caledonia", region: "Oceania" },
  NT: { issuer: "SEAC French Polynesia", country: "French Polynesia", region: "Oceania" },
  NS: { issuer: "SAA Samoa", country: "Samoa", region: "Oceania" },
  AY: { issuer: "NiuSky Pacific PNG", country: "Papua New Guinea", region: "Oceania" },
  AG: { issuer: "CAASI Solomon Islands", country: "Solomon Islands", region: "Oceania" },
  AN: { issuer: "NCAA Nauru", country: "Nauru", region: "Oceania" },

  // North America, Central America & Caribbean (K*, P*, C*, M*, T*)
  PA: { issuer: "FAA (US)", country: "United States", region: "North America" },
  PH: { issuer: "FAA (US)", country: "United States", region: "North America" },
  PG: { issuer: "FAA (US)", country: "Guam / US Pacific", region: "Oceania" },
  TJ: { issuer: "FAA (US)", country: "Puerto Rico / USVI", region: "North America" },
  MM: { issuer: "SENEAM Mexico", country: "Mexico", region: "North America" },
  MG: { issuer: "DGAC Guatemala", country: "Guatemala", region: "North America" },
  MH: { issuer: "COCESNA / AHAC", country: "Honduras / Central America", region: "North America" },
  MS: { issuer: "AAC El Salvador", country: "El Salvador", region: "North America" },
  MN: { issuer: "INAC Nicaragua", country: "Nicaragua", region: "North America" },
  MR: { issuer: "DGAC Costa Rica", country: "Costa Rica", region: "North America" },
  MP: { issuer: "AAC Panama", country: "Panama", region: "North America" },
  MZ: { issuer: "BDCA Belize", country: "Belize", region: "North America" },
  MU: { issuer: "IACC Cuba", country: "Cuba", region: "North America" },
  MK: { issuer: "JCAA Jamaica", country: "Jamaica", region: "North America" },
  MY: { issuer: "BCAA Bahamas", country: "Bahamas", region: "North America" },
  MD: { issuer: "IDAC Dominican Rep.", country: "Dominican Republic", region: "North America" },
  MT: { issuer: "OFNAC Haiti", country: "Haiti", region: "North America" },
  TT: { issuer: "TTCAA Trinidad", country: "Eastern Caribbean", region: "North America" },
  TB: { issuer: "BCAD Barbados", country: "Barbados", region: "North America" },
  TN: { issuer: "DCAA Dutch Caribbean", country: "Dutch Caribbean", region: "North America" },

  // South America (S*)
  SB: { issuer: "DECEA Brazil", country: "Brazil", region: "South America" },
  SD: { issuer: "DECEA Brazil", country: "Brazil", region: "South America" },
  SI: { issuer: "DECEA Brazil", country: "Brazil", region: "South America" },
  SJ: { issuer: "DECEA Brazil", country: "Brazil", region: "South America" },
  SN: { issuer: "DECEA Brazil", country: "Brazil", region: "South America" },
  SS: { issuer: "DECEA Brazil", country: "Brazil", region: "South America" },
  SW: { issuer: "DECEA Brazil", country: "Brazil", region: "South America" },
  SA: { issuer: "EANA Argentina", country: "Argentina", region: "South America" },
  SC: { issuer: "DGAC Chile", country: "Chile", region: "South America" },
  SK: { issuer: "Aerocivil Colombia", country: "Colombia", region: "South America" },
  SP: { issuer: "CORPAC Peru", country: "Peru", region: "South America" },
  SV: { issuer: "INAC Venezuela", country: "Venezuela", region: "South America" },
  SE: { issuer: "DGAC Ecuador", country: "Ecuador", region: "South America" },
  SL: { issuer: "NAABOL Bolivia", country: "Bolivia", region: "South America" },
  SG: { issuer: "DINAC Paraguay", country: "Paraguay", region: "South America" },
  SU: { issuer: "DINACIA Uruguay", country: "Uruguay", region: "South America" },
  SY: { issuer: "GCAA Guyana", country: "Guyana", region: "South America" },
  SM: { issuer: "CASAS Suriname", country: "Suriname", region: "South America" },
  SO: { issuer: "DGAC French Guiana", country: "French Guiana", region: "South America" },
};

const NAVAREA_METADATA: Record<string, AuthorityMetadata> = {
  I: { issuer: "UKHO Admiralty", country: "NE Atlantic / UK", region: "Europe" },
  II: { issuer: "SHOM France", country: "East Atlantic", region: "Europe" },
  III: { issuer: "IHM Spain / HNHS", country: "Mediterranean & Black Sea", region: "Europe" },
  IV: { issuer: "NGA / NOAA (US)", country: "NW Atlantic & Caribbean", region: "North America" },
  V: { issuer: "DHN Brazil", country: "SW Atlantic / Brazil", region: "South America" },
  VI: { issuer: "SHN Argentina", country: "SW Atlantic / Argentina", region: "South America" },
  VII: { issuer: "SANHO South Africa", country: "SE Atlantic & SW Indian", region: "Africa" },
  VIII: { issuer: "NHO India", country: "North & Central Indian Ocean", region: "Asia" },
  IX: { issuer: "PNHD Pakistan", country: "Red Sea, Gulf & Arabian Sea", region: "Middle East" },
  X: { issuer: "AMSA Australia", country: "Australia & SE Indian Ocean", region: "Oceania" },
  XI: { issuer: "JCG Japan", country: "NW Pacific & SE Asia", region: "Asia" },
  XII: { issuer: "NGA / NOAA (US)", country: "NE Pacific", region: "North America" },
  XIII: { issuer: "DNO Russia", country: "NW Pacific / Sea of Okhotsk", region: "Asia" },
  XIV: { issuer: "LINZ / MetService NZ", country: "South Pacific", region: "Oceania" },
  XV: { issuer: "SHOA / DIRECTEMAR Chile", country: "SE Pacific / Chile", region: "South America" },
  XVI: { issuer: "DHN Peru", country: "East Equatorial Pacific", region: "South America" },
  XVII: { issuer: "CCG Canada", country: "Arctic (Canada/Alaska)", region: "North America" },
  XVIII: { issuer: "CCG Canada", country: "Arctic (Northwest Passage)", region: "North America" },
  XIX: { issuer: "Kartverket Norway", country: "Arctic / Norwegian Sea", region: "Europe" },
  XX: { issuer: "DNO Russia", country: "Barents & Kara Seas", region: "Europe" },
  XXI: { issuer: "DNO Russia", country: "East Siberian Arctic", region: "Asia" },
};

export function resolveIcaoMetadata(
  icaoOrFir: string | undefined,
  domain: HazardDomain
): AuthorityMetadata {
  const code = (icaoOrFir ?? "").trim().toUpperCase();

  if (code.length >= 2) {
    const p2 = code.slice(0, 2);
    if (ICAO_TWO_LETTER_MAP[p2]) {
      const hit = ICAO_TWO_LETTER_MAP[p2];
      if (domain === "weather") {
        return {
          issuer:
            hit.country === "United States"
              ? "NOAA AWC (US)"
              : `WMO / ${hit.issuer}`,
          country: hit.country,
          region: hit.region,
        };
      }
      return hit;
    }

    const p1 = code[0];
    if (p1 === "K") {
      return {
        issuer: domain === "weather" ? "NOAA AWC (US)" : "FAA (US)",
        country: "United States",
        region: "North America",
      };
    }
    if (p1 === "C") {
      return {
        issuer: domain === "weather" ? "WMO / NAV CANADA" : "NAV CANADA",
        country: "Canada",
        region: "North America",
      };
    }
    if (p1 === "Y") {
      return {
        issuer:
          domain === "weather"
            ? "WMO / BoM Australia"
            : "Airservices Australia",
        country: "Australia",
        region: "Oceania",
      };
    }
    if (p1 === "Z") {
      return {
        issuer: domain === "weather" ? "WMO / CMA China" : "CAAC China",
        country: "China",
        region: "Asia",
      };
    }
    if (p1 === "E" || p1 === "L") {
      return {
        issuer: domain === "weather" ? "WMO / Eurocontrol Met" : "European CAA",
        country: "Europe",
        region: "Europe",
      };
    }
    if (p1 === "O") {
      return {
        issuer:
          domain === "weather" ? "WMO / Middle East Met" : "Middle East CAA",
        country: "Middle East",
        region: "Middle East",
      };
    }
    if (p1 === "D" || p1 === "F" || p1 === "G" || p1 === "H") {
      return {
        issuer: domain === "weather" ? "WMO / ASECNA Met" : "African CAA",
        country: "Africa",
        region: "Africa",
      };
    }
    if (p1 === "V" || p1 === "W" || p1 === "R") {
      return {
        issuer: domain === "weather" ? "WMO / Asia-Pacific Met" : "Asia CAA",
        country: "Asia",
        region: "Asia",
      };
    }
    if (p1 === "S") {
      return {
        issuer:
          domain === "weather" ? "WMO / South America Met" : "South America CAA",
        country: "South America",
        region: "South America",
      };
    }
    if (p1 === "M" || p1 === "T") {
      return {
        issuer:
          domain === "weather" ? "WMO / Caribbean Met" : "Caribbean / LatAm CAA",
        country: "Central America & Caribbean",
        region: "North America",
      };
    }
    if (p1 === "N" || p1 === "A" || p1 === "P") {
      return {
        issuer: domain === "weather" ? "WMO / Pacific Met" : "Pacific CAA",
        country: "Pacific Islands",
        region: "Oceania",
      };
    }
    if (p1 === "U") {
      return {
        issuer: domain === "weather" ? "WMO / CIS Met" : "Eurasia CAA",
        country: "Eurasia",
        region: "Asia",
      };
    }
  }

  return {
    issuer: domain === "weather" ? "NOAA AWC / WMO" : "International CAA",
    country: "Global",
    region: "High Seas",
  };
}

export function resolveNavAreaMetadata(navAreaRaw: string | undefined): AuthorityMetadata {
  const key = (navAreaRaw ?? "").trim().toUpperCase().replace(/^NAVAREA\s+/i, "");
  return (
    NAVAREA_METADATA[key] ?? {
      issuer: "WWNWS Maritime Authority",
      country: "High Seas",
      region: "High Seas",
    }
  );
}
