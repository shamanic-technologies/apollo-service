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
 * Standard LinkedIn/Apollo industries list.
 * Apollo uses LinkedIn's standardized 148 industries.
 */
const INDUSTRY_NAMES = [
  "Accounting",
  "Airlines/Aviation",
  "Alternative Dispute Resolution",
  "Alternative Medicine",
  "Animation",
  "Apparel & Fashion",
  "Architecture & Planning",
  "Arts and Crafts",
  "Automotive",
  "Aviation & Aerospace",
  "Banking",
  "Biotechnology",
  "Broadcast Media",
  "Building Materials",
  "Business Supplies and Equipment",
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
  "Health, Wellness and Fitness",
  "Higher Education",
  "Hospital & Health Care",
  "Hospitality",
  "Human Resources",
  "Import and Export",
  "Individual & Family Services",
  "Industrial Automation",
  "Information Services",
  "Information Technology and Services",
  "Insurance",
  "International Affairs",
  "International Trade and Development",
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
  "Logistics and Supply Chain",
  "Luxury Goods & Jewelry",
  "Machinery",
  "Management Consulting",
  "Maritime",
  "Market Research",
  "Marketing and Advertising",
  "Mechanical or Industrial Engineering",
  "Media Production",
  "Medical Devices",
  "Medical Practice",
  "Mental Health Care",
  "Military",
  "Mining & Metals",
  "Motion Pictures and Film",
  "Museums and Institutions",
  "Music",
  "Nanotechnology",
  "Newspapers",
  "Non-Profit Organization Management",
  "Oil & Energy",
  "Online Media",
  "Outsourcing/Offshoring",
  "Package/Freight Delivery",
  "Packaging and Containers",
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
  "Public Relations and Communications",
  "Public Safety",
  "Publishing",
  "Railroad Manufacture",
  "Ranching",
  "Real Estate",
  "Recreational Facilities and Services",
  "Religious Institutions",
  "Renewables & Environment",
  "Research",
  "Restaurants",
  "Retail",
  "Security and Investigations",
  "Semiconductors",
  "Shipbuilding",
  "Sporting Goods",
  "Sports",
  "Staffing and Recruiting",
  "Supermarkets",
  "Telecommunications",
  "Textiles",
  "Think Tanks",
  "Tobacco",
  "Translation and Localization",
  "Transportation/Trucking/Railroad",
  "Utilities",
  "Venture Capital & Private Equity",
  "Veterinary",
  "Warehousing",
  "Wholesale",
  "Wine and Spirits",
  "Wireless",
  "Writing and Editing",
] as const;

export const APOLLO_INDUSTRY_VALUES = INDUSTRY_NAMES.map((name) => name.toLowerCase()) as [
  string,
  ...string[],
];

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
