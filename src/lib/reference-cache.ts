/**
 * Static reference data for Apollo search parameters.
 * Industries use the standard LinkedIn industry list (same as Apollo).
 * Employee ranges are Apollo's standard ranges.
 */

export interface ApolloIndustry {
  name: string;
  value: string;
}

export interface ApolloEmployeeRange {
  label: string;
  value: string; // e.g., "1,10"
}

/**
 * Apollo's industry names, spelled EXACTLY as Apollo's `organization_industries`
 * filter matches them. Apollo matches the name verbatim: LinkedIn's
 * "Marketing and Advertising" counts 0 people while Apollo's own
 * "Marketing & Advertising" counts 2,463,094 (APOLLO-INDUSTRIES-ZERO-1126).
 * Every value is pinned by a live count > 0 (see the regression test); never
 * add a name without a free dry-run count delta.
 */
const INDUSTRY_NAMES = [
  "Accounting",
  "Airlines/Aviation",
  "Alternative Dispute Resolution",
  "Alternative Medicine",
  "Animation",
  "Apparel & Fashion",
  "Architecture & Planning",
  "Arts & Crafts",
  "Automotive",
  "Aviation & Aerospace",
  "Banking",
  "Biotechnology",
  "Broadcast Media",
  "Building Materials",
  "Business Supplies & Equipment",
  "Capital Markets",
  "Chemicals",
  "Civic & Social Organization",
  "Civil Engineering",
  "Commercial Real Estate",
  "Computer & Network Security",
  "Computer Games",
  "Computer Hardware",
  "Computer Networking",
  "Computer Software",
  "Construction",
  "Consumer Electronics",
  "Consumer Goods",
  "Consumer Services",
  "Cosmetics",
  "Dairy",
  "Defense & Space",
  "Design",
  "E-Learning",
  "Education Management",
  "Electrical/Electronic Manufacturing",
  "Entertainment",
  "Environmental Services",
  "Events Services",
  "Executive Office",
  "Facilities Services",
  "Farming",
  "Financial Services",
  "Fine Art",
  "Fishery",
  "Food & Beverages",
  "Food Production",
  "Fund-Raising",
  "Furniture",
  "Gambling & Casinos",
  "Glass, Ceramics & Concrete",
  "Government Administration",
  "Government Relations",
  "Graphic Design",
  "Health, Wellness & Fitness",
  "Higher Education",
  "Hospital & Health Care",
  "Hospitality",
  "Human Resources",
  "Import & Export",
  "Individual & Family Services",
  "Industrial Automation",
  "Information Services",
  "Information Technology & Services",
  "Insurance",
  "International Affairs",
  "International Trade & Development",
  "Internet",
  "Investment Banking",
  "Investment Management",
  "Judiciary",
  "Law Enforcement",
  "Law Practice",
  "Legal Services",
  "Legislative Office",
  "Leisure, Travel & Tourism",
  "Libraries",
  "Logistics & Supply Chain",
  "Luxury Goods & Jewelry",
  "Machinery",
  "Management Consulting",
  "Maritime",
  "Market Research",
  "Marketing & Advertising",
  "Mechanical or Industrial Engineering",
  "Media Production",
  "Medical Devices",
  "Medical Practice",
  "Mental Health Care",
  "Military",
  "Mining & Metals",
  "Motion Pictures & Film",
  "Museums & Institutions",
  "Music",
  "Nanotechnology",
  "Newspapers",
  "Nonprofit Organization Management",
  "Oil & Energy",
  "Online Media",
  "Outsourcing/Offshoring",
  "Package/Freight Delivery",
  "Packaging & Containers",
  "Paper & Forest Products",
  "Performing Arts",
  "Pharmaceuticals",
  "Philanthropy",
  "Photography",
  "Plastics",
  "Political Organization",
  "Primary/Secondary Education",
  "Printing",
  "Professional Training & Coaching",
  "Program Development",
  "Public Policy",
  "Public Relations & Communications",
  "Public Safety",
  "Publishing",
  "Railroad Manufacture",
  "Ranching",
  "Real Estate",
  "Recreational Facilities & Services",
  "Religious Institutions",
  "Renewables & Environment",
  "Research",
  "Restaurants",
  "Retail",
  "Security & Investigations",
  "Semiconductors",
  "Shipbuilding",
  "Sporting Goods",
  "Sports",
  "Staffing & Recruiting",
  "Supermarkets",
  "Telecommunications",
  "Textiles",
  "Think Tanks",
  "Tobacco",
  "Translation & Localization",
  "Transportation/Trucking/Railroad",
  "Utilities",
  "Venture Capital & Private Equity",
  "Veterinary",
  "Warehousing",
  "Wholesale",
  "Wine & Spirits",
  "Wireless",
  "Writing & Editing",
] as const;

export const APOLLO_INDUSTRY_VALUES = INDUSTRY_NAMES.map((name) => name.toLowerCase()) as [
  string,
  ...string[],
];

/**
 * The LinkedIn spellings this enum published until 2026-11-26. Apollo matched
 * none of them (0 people), but audiences and callers stored them verbatim, so
 * they are still ACCEPTED and translated to Apollo's spelling: same industry,
 * same filter, never a rewrite into another field. Never published.
 */
export const LEGACY_INDUSTRY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "arts and crafts": "arts & crafts",
  "business supplies and equipment": "business supplies & equipment",
  "health, wellness and fitness": "health, wellness & fitness",
  "import and export": "import & export",
  "information technology and services": "information technology & services",
  "international trade and development": "international trade & development",
  "logistics and supply chain": "logistics & supply chain",
  "marketing and advertising": "marketing & advertising",
  "motion pictures and film": "motion pictures & film",
  "museums and institutions": "museums & institutions",
  "non-profit organization management": "nonprofit organization management",
  "packaging and containers": "packaging & containers",
  "public relations and communications": "public relations & communications",
  "recreational facilities and services": "recreational facilities & services",
  "security and investigations": "security & investigations",
  "staffing and recruiting": "staffing & recruiting",
  "translation and localization": "translation & localization",
  "wine and spirits": "wine & spirits",
  "writing and editing": "writing & editing",
});

/** Apollo's spelling of an industry value (lower-cased; legacy LinkedIn spellings translated). */
export function canonicalApolloIndustry(value: string): string {
  const lower = value.toLowerCase();
  return LEGACY_INDUSTRY_ALIASES[lower] ?? lower;
}

const INDUSTRIES: ApolloIndustry[] = INDUSTRY_NAMES.map((name) => ({
  name,
  value: name.toLowerCase(),
}));

/**
 * Get the standard Apollo/LinkedIn industries list.
 * Static data — no API call needed.
 */
export function getIndustries(): ApolloIndustry[] {
  return INDUSTRIES;
}

/**
 * Get employee ranges (static values from Apollo docs)
 */
export function getEmployeeRanges(): ApolloEmployeeRange[] {
  return [
    { label: "1-10", value: "1,10" },
    { label: "11-20", value: "11,20" },
    { label: "21-50", value: "21,50" },
    { label: "51-100", value: "51,100" },
    { label: "101-200", value: "101,200" },
    { label: "201-500", value: "201,500" },
    { label: "501-1000", value: "501,1000" },
    { label: "1001-2000", value: "1001,2000" },
    { label: "2001-5000", value: "2001,5000" },
    { label: "5001-10000", value: "5001,10000" },
    { label: "10001+", value: "10001," },
  ];
}
