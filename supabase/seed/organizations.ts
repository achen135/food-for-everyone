/**
 * Seed organizations — 30 fictional organizations at real Chicago-area
 * addresses, so PostGIS radius queries return something interesting.
 *
 * The names, descriptions, emails and phone numbers are invented. No real
 * business or charity is represented here. Emails and websites use the reserved
 * `.invalid` TLD (RFC 2606) and phone numbers use the reserved 555-01xx range,
 * so none of them can reach anybody.
 *
 * Coordinates are real: each address was geocoded once through the same
 * Nominatim endpoint the app uses (2026-08-30) and the result baked in here, so
 * running the seed makes no geocoder requests.
 *
 * Anything created from this file is SEEDED DEMO DATA. If it ever backs a
 * number in a write-up or a résumé bullet, it is described as seeded — never as
 * real traffic (Spec §9, integrity note).
 */

export interface SeedOrganization {
  /** Stable key — also used to build the seed account's email address. */
  slug: string;
  name: string;
  type: "donor" | "recipient";
  description: string;
  email: string;
  phone: string;
  website: string | null;
  address: string;
  latitude: number;
  longitude: number;
  verified: boolean;
}

// 30 organizations — 16 donors, 14 recipients.
export const SEED_ORGANIZATIONS: SeedOrganization[] = [
  {
    slug: "wacker-street-bistro",
    name: "Wacker Street Bistro",
    type: "donor",
    description:
      "Downtown bistro. Surplus prepared meals and bread most weeknights after 9pm.",
    email: "hello@wacker-street-bistro.invalid",
    phone: "(312) 555-0100",
    website: "https://wacker-street-bistro.invalid",
    address:
      "Willis Tower, 233, South Wacker Drive, Financial District, Loop, Chicago, South Chicago Township, Cook County, Illinois, 60606, United States",
    latitude: 41.878738,
    longitude: -87.6359612,
    verified: true,
  },
  {
    slug: "magnificent-mile-grocers",
    name: "Magnificent Mile Grocers",
    type: "donor",
    description:
      "Grocery with daily produce and bakery overstock. Loading dock pickup.",
    email: "hello@magnificent-mile-grocers.invalid",
    phone: "(773) 555-0101",
    website: null,
    address:
      "875 N Michigan, 875, North Michigan Avenue, Streeterville, Gold Coast, Near North Side, Chicago, North Chicago Township, Cook County, Illinois, 60611, United States",
    latitude: 41.8988813,
    longitude: -87.6230962,
    verified: true,
  },
  {
    slug: "lakeside-harvest-pantry",
    name: "Lakeside Harvest Pantry",
    type: "recipient",
    description:
      "Neighbourhood pantry serving Hyde Park and Woodlawn. Refrigerated storage on site.",
    email: "hello@lakeside-harvest-pantry.invalid",
    phone: "(872) 555-0102",
    website: null,
    address:
      "Griffin Museum of Science and Industry, 5700, South Lake Shore Drive, Indian Village, Kenwood, Chicago, Hyde Park Township, Cook County, Illinois, 60637, United States",
    latitude: 41.7907492,
    longitude: -87.582931,
    verified: true,
  },
  {
    slug: "cannon-drive-cafe",
    name: "Cannon Drive Cafe",
    type: "donor",
    description:
      "Cafe with end-of-day pastries and sandwiches. Small volumes, daily.",
    email: "hello@cannon-drive-cafe.invalid",
    phone: "(312) 555-0103",
    website: "https://cannon-drive-cafe.invalid",
    address:
      "The Peggy Notebaert Nature Museum, 2430, North Cannon Drive, Lincoln Park, Chicago, Lake View Township, Cook County, Illinois, 60614, United States",
    latitude: 41.9269829,
    longitude: -87.6354214,
    verified: false,
  },
  {
    slug: "addison-ballpark-concessions",
    name: "Addison Ballpark Concessions",
    type: "donor",
    description:
      "Event caterer. Large surplus after home games — needs same-night collection.",
    email: "hello@addison-ballpark-concessions.invalid",
    phone: "(773) 555-0104",
    website: null,
    address:
      "Wrigley Field, 1060, West Addison Street, Wrigleyville, Lake View, Chicago, Lake View Township, Cook County, Illinois, 60613, United States",
    latitude: 41.9481846,
    longitude: -87.655559,
    verified: true,
  },
  {
    slug: "bridgeport-community-fridge",
    name: "Bridgeport Community Fridge",
    type: "recipient",
    description:
      "Volunteer-run community fridge, restocked twice daily. No cooked food.",
    email: "hello@bridgeport-community-fridge.invalid",
    phone: "(872) 555-0105",
    website: null,
    address:
      "Rate Field, 333, West 35th Street, Armour Square, Chicago, South Chicago Township, Cook County, Illinois, 60616, United States",
    latitude: 41.829692,
    longitude: -87.6337919,
    verified: false,
  },
  {
    slug: "near-west-meal-program",
    name: "Near West Meal Program",
    type: "recipient",
    description:
      "Hot meal service five days a week. Can collect with our own van.",
    email: "hello@near-west-meal-program.invalid",
    phone: "(312) 555-0106",
    website: "https://near-west-meal-program.invalid",
    address:
      "United Center, 1901, West Madison Street, West Haven, Near West Side, Chicago, West Chicago Township, Cook County, Illinois, 60612, United States",
    latitude: 41.8806831,
    longitude: -87.6741851,
    verified: true,
  },
  {
    slug: "clark-street-deli",
    name: "Clark Street Deli",
    type: "donor",
    description: "Deli with daily surplus sandwiches, salads, and soup.",
    email: "hello@clark-street-deli.invalid",
    phone: "(773) 555-0107",
    website: null,
    address:
      "3717, North Clark Street, Wrigleyville, Lake View, Chicago, Lake View Township, Cook County, Illinois, 60613, United States",
    latitude: 41.9493636,
    longitude: -87.6581251,
    verified: false,
  },
  {
    slug: "wicker-park-bakehouse",
    name: "Wicker Park Bakehouse",
    type: "donor",
    description:
      "Bakery. Bread and pastry surplus every evening except Sunday.",
    email: "hello@wicker-park-bakehouse.invalid",
    phone: "(872) 555-0108",
    website: null,
    address:
      "1550, North Damen Avenue, Wicker Park, West Town, Chicago, West Chicago Township, Cook County, Illinois, 60622, United States",
    latitude: 41.9096759,
    longitude: -87.6775531,
    verified: true,
  },
  {
    slug: "logan-square-food-collective",
    name: "Logan Square Food Collective",
    type: "recipient",
    description:
      "Collective distributing to 40 households weekly. Cold storage available.",
    email: "hello@logan-square-food-collective.invalid",
    phone: "(312) 555-0109",
    website: "https://logan-square-food-collective.invalid",
    address:
      "Walgreens, 2001, North Milwaukee Avenue, West Bucktown, Wicker Park, Logan Square, Chicago, West Chicago Township, Cook County, Illinois, 60647, United States",
    latitude: 41.9179003,
    longitude: -87.6883838,
    verified: true,
  },
  {
    slug: "edgewater-fresh-market",
    name: "Edgewater Fresh Market",
    type: "donor",
    description:
      "Independent grocer. Produce, dairy, and dry goods nearing date.",
    email: "hello@edgewater-fresh-market.invalid",
    phone: "(773) 555-0110",
    website: null,
    address:
      "6100-6122, North Broadway, Edgewater Glen, Edgewater, Chicago, Lake View Township, Cook County, Illinois, 60660, United States",
    latitude: 41.9929203,
    longitude: -87.6607685,
    verified: true,
  },
  {
    slug: "albany-park-family-pantry",
    name: "Albany Park Family Pantry",
    type: "recipient",
    description:
      "Family pantry with multilingual volunteers. Weekday collection only.",
    email: "hello@albany-park-family-pantry.invalid",
    phone: "(872) 555-0111",
    website: null,
    address:
      "Nubar Cafe, 3200, West Lawrence Avenue, Albany Park, Chicago, Jefferson Township, Cook County, Illinois, 60625, United States",
    latitude: 41.9685773,
    longitude: -87.7086292,
    verified: true,
  },
  {
    slug: "uptown-kitchen-co-op",
    name: "Uptown Kitchen Co-op",
    type: "donor",
    description:
      "Shared commercial kitchen. Irregular but sometimes large surplus.",
    email: "hello@uptown-kitchen-co-op.invalid",
    phone: "(312) 555-0112",
    website: "https://uptown-kitchen-co-op.invalid",
    address:
      "Green Mill Cocktail Lounge, 4802, North Broadway, Uptown Square, Uptown, Chicago, Lake View Township, Cook County, Illinois, 60640, United States",
    latitude: 41.9691831,
    longitude: -87.6598913,
    verified: false,
  },
  {
    slug: "mckinley-park-shelter-kitchen",
    name: "McKinley Park Shelter Kitchen",
    type: "recipient",
    description:
      "Shelter serving three meals daily. Needs dependable weekly volume.",
    email: "hello@mckinley-park-shelter-kitchen.invalid",
    phone: "(773) 555-0113",
    website: null,
    address:
      "1200, West 35th Street, Stockyards Industrial Corridor, Bridgeport, Chicago, South Chicago Township, Cook County, Illinois, 60609, United States",
    latitude: 41.8309771,
    longitude: -87.6565482,
    verified: true,
  },
  {
    slug: "cottage-grove-outreach",
    name: "Cottage Grove Outreach",
    type: "recipient",
    description: "Outreach programme with a mobile distribution van.",
    email: "hello@cottage-grove-outreach.invalid",
    phone: "(872) 555-0114",
    website: null,
    address:
      "9200-9204, South Cottage Grove Avenue, Dauphin Park, Chatham, Chicago, Hyde Park Township, Cook County, Illinois, 60619, United States",
    latitude: 41.7273447,
    longitude: -87.6048533,
    verified: false,
  },
  {
    slug: "randolph-street-catering",
    name: "Randolph Street Catering",
    type: "donor",
    description:
      "Event catering. Surplus after corporate functions, often short notice.",
    email: "hello@randolph-street-catering.invalid",
    phone: "(312) 555-0115",
    website: "https://randolph-street-catering.invalid",
    address:
      "Outer Drive East, 400, East Randolph Street, New East Side, Loop, Chicago, South Chicago Township, Cook County, Illinois, 60601, United States",
    latitude: 41.8849865,
    longitude: -87.6165376,
    verified: true,
  },
  {
    slug: "taylor-street-trattoria",
    name: "Taylor Street Trattoria",
    type: "donor",
    description: "Family trattoria. Prepared pasta and bread most evenings.",
    email: "hello@taylor-street-trattoria.invalid",
    phone: "(773) 555-0116",
    website: null,
    address:
      "1140, West Taylor Street, Roosevelt Square, Little Italy, Near West Side, Chicago, West Chicago Township, Cook County, Illinois, 60607, United States",
    latitude: 41.8695659,
    longitude: -87.6558701,
    verified: false,
  },
  {
    slug: "devon-avenue-halal-grocers",
    name: "Devon Avenue Halal Grocers",
    type: "donor",
    description:
      "Halal grocery with produce and bakery surplus. Daily pickup window.",
    email: "hello@devon-avenue-halal-grocers.invalid",
    phone: "(872) 555-0117",
    website: null,
    address:
      "2500-2502, West Devon Avenue, West Ridge, Chicago, Rogers Park Township, Cook County, Illinois, 60659, United States",
    latitude: 41.9979367,
    longitude: -87.6925581,
    verified: true,
  },
  {
    slug: "halsted-community-table",
    name: "Halsted Community Table",
    type: "recipient",
    description: "Community meal programme, Tuesdays and Thursdays.",
    email: "hello@halsted-community-table.invalid",
    phone: "(312) 555-0118",
    website: "https://halsted-community-table.invalid",
    address:
      "3400-3402, North Halsted Street, Northalsted, Lake View, Chicago, Lake View Township, Cook County, Illinois, 60657, United States",
    latitude: 41.9437418,
    longitude: -87.6497251,
    verified: true,
  },
  {
    slug: "chatham-neighbours-pantry",
    name: "Chatham Neighbours Pantry",
    type: "recipient",
    description:
      "Pantry serving Chatham and Avalon Park. Freezer capacity available.",
    email: "hello@chatham-neighbours-pantry.invalid",
    phone: "(773) 555-0119",
    website: null,
    address:
      "Social Security Administration, 700, East 79th Street, Grand Crossing, Greater Grand Crossing, Chicago, Hyde Park Township, Cook County, Illinois, 60619, United States",
    latitude: 41.751387,
    longitude: -87.6073561,
    verified: true,
  },
  {
    slug: "western-avenue-produce",
    name: "Western Avenue Produce",
    type: "donor",
    description:
      "Wholesale produce. Pallet-scale surplus, needs a van or truck.",
    email: "hello@western-avenue-produce.invalid",
    phone: "(872) 555-0120",
    website: null,
    address:
      "1601, North Western Avenue, Wicker Park, West Town, Chicago, West Chicago Township, Cook County, Illinois, 60647, United States",
    latitude: 41.910946,
    longitude: -87.687127,
    verified: true,
  },
  {
    slug: "archer-heights-food-hub",
    name: "Archer Heights Food Hub",
    type: "recipient",
    description:
      "Regional hub redistributing to smaller pantries. Large volumes welcome.",
    email: "hello@archer-heights-food-hub.invalid",
    phone: "(312) 555-0121",
    website: "https://archer-heights-food-hub.invalid",
    address:
      "5050, South Pulaski Road, Archer Heights, Chicago, Lake Township, Cook County, Illinois, 60632, United States",
    latitude: 41.8013795,
    longitude: -87.7235056,
    verified: true,
  },
  {
    slug: "uic-campus-dining",
    name: "UIC Campus Dining",
    type: "donor",
    description:
      "Campus dining halls. Predictable weekday surplus during term.",
    email: "hello@uic-campus-dining.invalid",
    phone: "(773) 555-0122",
    website: null,
    address:
      "Jane Addams Hull-House Museum, 800, South Halsted Street, Little Italy, Near West Side, Chicago, West Chicago Township, Cook County, Illinois, 60607, United States",
    latitude: 41.8716513,
    longitude: -87.6473972,
    verified: true,
  },
  {
    slug: "central-park-community-fridge",
    name: "Central Park Community Fridge",
    type: "recipient",
    description: "Street-side fridge and pantry, restocked by volunteers.",
    email: "hello@central-park-community-fridge.invalid",
    phone: "(872) 555-0123",
    website: null,
    address:
      "2600, North Central Park Avenue, Jackowo, Chicago, Jefferson Township, Cook County, Illinois, 60647, United States",
    latitude: 41.928833,
    longitude: -87.717217,
    verified: false,
  },
  {
    slug: "ashland-corner-store",
    name: "Ashland Corner Store",
    type: "donor",
    description: "Corner store with dairy and packaged goods nearing date.",
    email: "hello@ashland-corner-store.invalid",
    phone: "(312) 555-0124",
    website: "https://ashland-corner-store.invalid",
    address:
      "Division, 1200, North Ashland Avenue, Pulaski Park, Wicker Park, West Town, Chicago, West Chicago Township, Cook County, Illinois, 60622, United States",
    latitude: 41.9037547,
    longitude: -87.6675232,
    verified: false,
  },
  {
    slug: "south-shore-meals-on-wheels",
    name: "South Shore Meals on Wheels",
    type: "recipient",
    description: "Home delivery for older residents. Needs portion-ready food.",
    email: "hello@south-shore-meals-on-wheels.invalid",
    phone: "(773) 555-0125",
    website: null,
    address:
      "7100, South Stony Island Avenue, South Shore, Chicago, Hyde Park Township, Cook County, Illinois, 60649, United States",
    latitude: 41.765852,
    longitude: -87.586432,
    verified: true,
  },
  {
    slug: "portage-park-pizzeria",
    name: "Portage Park Pizzeria",
    type: "donor",
    description: "Pizzeria with nightly surplus dough and prepared pizzas.",
    email: "hello@portage-park-pizzeria.invalid",
    phone: "(872) 555-0126",
    website: null,
    address:
      "4400-4406, North Milwaukee Avenue, Portage Park, Chicago, Jefferson Township, Cook County, Illinois, 60630, United States",
    latitude: 41.9608102,
    longitude: -87.754927,
    verified: false,
  },
  {
    slug: "fullerton-student-pantry",
    name: "Fullerton Student Pantry",
    type: "recipient",
    description:
      "Student-run pantry. Shelf-stable and fresh produce both welcome.",
    email: "hello@fullerton-student-pantry.invalid",
    phone: "(312) 555-0127",
    website: "https://fullerton-student-pantry.invalid",
    address:
      "1340-1350, West Fullerton Avenue, Sheffield Neighbors, Lincoln Park, Chicago, North Chicago Township, Cook County, Illinois, 60614, United States",
    latitude: 41.9254596,
    longitude: -87.6624003,
    verified: true,
  },
  {
    slug: "oak-park-farmstand",
    name: "Oak Park Farmstand",
    type: "donor",
    description: "Farmstand with weekend produce surplus. Seasonal.",
    email: "hello@oak-park-farmstand.invalid",
    phone: "(773) 555-0128",
    website: null,
    address:
      "Albion Oak Park, 1000, Lake Street, Downtown, Oak Park, Cook County, Illinois, 60301, United States",
    latitude: 41.8891493,
    longitude: -87.800574,
    verified: true,
  },
  {
    slug: "evanston-shelter-services",
    name: "Evanston Shelter Services",
    type: "recipient",
    description:
      "Overnight shelter with a full kitchen. Collection by arrangement.",
    email: "hello@evanston-shelter-services.invalid",
    phone: "(872) 555-0129",
    website: null,
    address:
      "800, Davis Street, Downtown, Evanston, Evanston Township, Cook County, Illinois, 60201, United States",
    latitude: 42.0467271,
    longitude: -87.6821982,
    verified: true,
  },
];
