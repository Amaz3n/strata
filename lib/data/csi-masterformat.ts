import type { CostType } from "@/lib/cost-types"

export type CSISection = readonly [code: string, name: string]

export type CSIDivision = {
  division: string
  name: string
  costType: CostType
  sections: readonly CSISection[]
}

export const CSI_MASTERFORMAT_DIVISIONS: readonly CSIDivision[] = [
  { division: "01", name: "General Requirements", costType: "other", sections: [
    ["01 10 00", "Summary"], ["01 20 00", "Price and Payment Procedures"],
    ["01 25 00", "Substitution Procedures"], ["01 29 00", "Payment Procedures"],
    ["01 31 00", "Project Management and Coordination"], ["01 33 00", "Submittal Procedures"],
    ["01 40 00", "Quality Requirements"], ["01 50 00", "Temporary Facilities and Controls"],
    ["01 70 00", "Execution and Closeout Requirements"], ["01 78 00", "Closeout Submittals"],
  ] },
  { division: "02", name: "Existing Conditions", costType: "subcontract", sections: [
    ["02 22 00", "Existing Conditions Assessment"], ["02 41 00", "Demolition"],
    ["02 42 00", "Removal and Salvage of Construction Materials"], ["02 81 00", "Transportation and Disposal of Hazardous Materials"],
    ["02 82 00", "Asbestos Remediation"], ["02 83 00", "Lead Remediation"],
    ["02 84 00", "Polychlorinated Biphenyl Remediation"], ["02 85 00", "Mold Remediation"],
  ] },
  { division: "03", name: "Concrete", costType: "subcontract", sections: [
    ["03 10 00", "Concrete Forming and Accessories"], ["03 20 00", "Concrete Reinforcing"],
    ["03 30 00", "Cast-in-Place Concrete"], ["03 35 00", "Concrete Finishing"],
    ["03 40 00", "Precast Concrete"], ["03 45 00", "Precast Architectural Concrete"],
    ["03 48 00", "Precast Concrete Specialties"], ["03 54 00", "Cast Underlayment"],
    ["03 60 00", "Grouting"],
  ] },
  { division: "04", name: "Masonry", costType: "subcontract", sections: [
    ["04 01 00", "Maintenance of Masonry"], ["04 05 00", "Common Work Results for Masonry"],
    ["04 20 00", "Unit Masonry"], ["04 21 13", "Brick Masonry"],
    ["04 22 00", "Concrete Unit Masonry"], ["04 40 00", "Stone Assemblies"],
    ["04 42 00", "Exterior Stone Cladding"], ["04 43 00", "Stone Masonry"],
    ["04 72 00", "Cast Stone Masonry"],
  ] },
  { division: "05", name: "Metals", costType: "subcontract", sections: [
    ["05 05 00", "Common Work Results for Metals"], ["05 10 00", "Structural Metal Framing"],
    ["05 12 00", "Structural Steel Framing"], ["05 21 00", "Steel Joist Framing"],
    ["05 31 00", "Steel Decking"], ["05 40 00", "Cold-Formed Metal Framing"],
    ["05 50 00", "Metal Fabrications"], ["05 51 00", "Metal Stairs"],
    ["05 52 00", "Metal Railings"],
  ] },
  { division: "06", name: "Wood, Plastics, and Composites", costType: "subcontract", sections: [
    ["06 10 00", "Rough Carpentry"], ["06 16 00", "Sheathing"],
    ["06 17 00", "Shop-Fabricated Structural Wood"], ["06 18 00", "Glued-Laminated Construction"],
    ["06 20 00", "Finish Carpentry"], ["06 40 00", "Architectural Woodwork"],
    ["06 41 00", "Architectural Wood Casework"], ["06 61 00", "Simulated Stone Fabrications"],
    ["06 73 00", "Composite Decking"],
  ] },
  { division: "07", name: "Thermal and Moisture Protection", costType: "subcontract", sections: [
    ["07 10 00", "Dampproofing and Waterproofing"], ["07 20 00", "Thermal Protection"],
    ["07 24 00", "Thermal and Moisture Protection Systems"], ["07 25 00", "Weather Barriers"],
    ["07 30 00", "Steep Slope Roofing"], ["07 42 00", "Wall Panels"],
    ["07 50 00", "Membrane Roofing"], ["07 60 00", "Flashing and Sheet Metal"],
    ["07 84 00", "Firestopping"], ["07 92 00", "Joint Sealants"],
  ] },
  { division: "08", name: "Openings", costType: "subcontract", sections: [
    ["08 10 00", "Doors and Frames"], ["08 11 00", "Metal Doors and Frames"],
    ["08 14 00", "Wood Doors"], ["08 30 00", "Specialty Doors and Frames"],
    ["08 33 00", "Coiling Doors and Grilles"], ["08 41 00", "Entrances and Storefronts"],
    ["08 44 00", "Curtain Wall and Glazed Assemblies"], ["08 50 00", "Windows"],
    ["08 71 00", "Door Hardware"], ["08 80 00", "Glazing"],
  ] },
  { division: "09", name: "Finishes", costType: "subcontract", sections: [
    ["09 20 00", "Plaster and Gypsum Board"], ["09 22 00", "Supports for Plaster and Gypsum Board"],
    ["09 29 00", "Gypsum Board"], ["09 30 00", "Tiling"],
    ["09 51 00", "Acoustical Ceilings"], ["09 64 00", "Wood Flooring"],
    ["09 65 00", "Resilient Flooring"], ["09 68 00", "Carpeting"],
    ["09 91 00", "Painting"], ["09 96 00", "High-Performance Coatings"],
  ] },
  { division: "10", name: "Specialties", costType: "subcontract", sections: [
    ["10 11 00", "Visual Display Units"], ["10 14 00", "Signage"],
    ["10 21 00", "Compartments and Cubicles"], ["10 26 00", "Wall and Door Protection"],
    ["10 28 00", "Toilet, Bath, and Laundry Accessories"], ["10 44 00", "Fire Protection Specialties"],
    ["10 51 00", "Lockers"], ["10 56 00", "Storage Assemblies"],
    ["10 73 00", "Protective Covers"],
  ] },
  { division: "11", name: "Equipment", costType: "equipment", sections: [
    ["11 13 00", "Loading Dock Equipment"], ["11 24 00", "Maintenance Equipment"],
    ["11 31 00", "Residential Appliances"], ["11 40 00", "Foodservice Equipment"],
    ["11 52 00", "Audio-Visual Equipment"], ["11 53 00", "Laboratory Equipment"],
    ["11 66 00", "Athletic Equipment"], ["11 68 00", "Play Field Equipment and Structures"],
    ["11 82 00", "Solid Waste Handling Equipment"],
  ] },
  { division: "12", name: "Furnishings", costType: "material", sections: [
    ["12 20 00", "Window Treatments"], ["12 24 00", "Window Shades"],
    ["12 32 00", "Manufactured Wood Casework"], ["12 36 00", "Countertops"],
    ["12 48 00", "Entrance Floor Mats and Frames"], ["12 50 00", "Furniture"],
    ["12 60 00", "Multiple Seating"], ["12 93 00", "Site Furnishings"],
  ] },
  { division: "13", name: "Special Construction", costType: "subcontract", sections: [
    ["13 11 00", "Swimming Pools"], ["13 21 00", "Controlled Environment Rooms"],
    ["13 24 00", "Special Activity Rooms"], ["13 27 00", "Vaults"],
    ["13 34 00", "Fabricated Engineered Structures"], ["13 42 00", "Building Modules"],
    ["13 48 00", "Sound, Vibration, and Seismic Control"], ["13 49 00", "Radiation Protection"],
  ] },
  { division: "14", name: "Conveying Equipment", costType: "equipment", sections: [
    ["14 10 00", "Dumbwaiters"], ["14 20 00", "Elevators"],
    ["14 21 00", "Electric Traction Elevators"], ["14 24 00", "Hydraulic Elevators"],
    ["14 30 00", "Escalators and Moving Walks"], ["14 40 00", "Lifts"],
    ["14 42 00", "Wheelchair Lifts"], ["14 50 00", "Custom Lift Systems"],
  ] },
  { division: "21", name: "Fire Suppression", costType: "subcontract", sections: [
    ["21 05 00", "Common Work Results for Fire Suppression"], ["21 10 00", "Water-Based Fire-Suppression Systems"],
    ["21 11 00", "Facility Fire-Suppression Water-Service Piping"], ["21 12 00", "Fire-Suppression Standpipes"],
    ["21 13 00", "Fire-Suppression Sprinkler Systems"], ["21 20 00", "Fire-Extinguishing Systems"],
    ["21 22 00", "Clean-Agent Fire-Extinguishing Systems"], ["21 30 00", "Fire Pumps"],
    ["21 40 00", "Fire-Suppression Water Storage"],
  ] },
  { division: "22", name: "Plumbing", costType: "subcontract", sections: [
    ["22 05 00", "Common Work Results for Plumbing"], ["22 07 00", "Plumbing Insulation"],
    ["22 10 00", "Plumbing Piping"], ["22 11 00", "Facility Water Distribution"],
    ["22 13 00", "Facility Sanitary Sewerage"], ["22 14 00", "Facility Storm Drainage"],
    ["22 30 00", "Plumbing Equipment"], ["22 40 00", "Plumbing Fixtures"],
    ["22 60 00", "Gas and Vacuum Systems for Laboratory and Healthcare Facilities"],
  ] },
  { division: "23", name: "Heating, Ventilating, and Air Conditioning", costType: "subcontract", sections: [
    ["23 05 00", "Common Work Results for HVAC"], ["23 07 00", "HVAC Insulation"],
    ["23 09 00", "Instrumentation and Control for HVAC"], ["23 20 00", "HVAC Piping and Pumps"],
    ["23 30 00", "HVAC Air Distribution"], ["23 31 00", "HVAC Ducts and Casings"],
    ["23 34 00", "HVAC Fans"], ["23 37 00", "Air Outlets and Inlets"],
    ["23 70 00", "Central HVAC Equipment"], ["23 80 00", "Decentralized HVAC Equipment"],
  ] },
  { division: "26", name: "Electrical", costType: "subcontract", sections: [
    ["26 05 00", "Common Work Results for Electrical"], ["26 09 00", "Instrumentation and Control for Electrical Systems"],
    ["26 20 00", "Low-Voltage Electrical Distribution"], ["26 24 00", "Switchboards and Panelboards"],
    ["26 27 00", "Low-Voltage Distribution Equipment"], ["26 28 00", "Low-Voltage Circuit Protective Devices"],
    ["26 32 00", "Packaged Generator Assemblies"], ["26 41 00", "Facility Lightning Protection"],
    ["26 50 00", "Lighting"],
  ] },
  { division: "27", name: "Communications", costType: "subcontract", sections: [
    ["27 05 00", "Common Work Results for Communications"], ["27 10 00", "Structured Cabling"],
    ["27 11 00", "Communications Equipment Room Fittings"], ["27 13 00", "Communications Backbone Cabling"],
    ["27 15 00", "Communications Horizontal Cabling"], ["27 20 00", "Data Communications"],
    ["27 30 00", "Voice Communications"], ["27 40 00", "Audio-Video Communications"],
    ["27 50 00", "Distributed Communications and Monitoring Systems"],
  ] },
  { division: "28", name: "Electronic Safety and Security", costType: "subcontract", sections: [
    ["28 05 00", "Common Work Results for Electronic Safety and Security"], ["28 10 00", "Electronic Access Control and Intrusion Detection"],
    ["28 13 00", "Access Control"], ["28 20 00", "Electronic Surveillance"],
    ["28 23 00", "Video Surveillance"], ["28 30 00", "Electronic Detection and Alarm"],
    ["28 31 00", "Intrusion Detection"], ["28 40 00", "Electronic Monitoring and Control"],
    ["28 46 00", "Fire Detection and Alarm"],
  ] },
  { division: "31", name: "Earthwork", costType: "subcontract", sections: [
    ["31 10 00", "Site Clearing"], ["31 20 00", "Earth Moving"],
    ["31 23 00", "Excavation and Fill"], ["31 25 00", "Erosion and Sedimentation Controls"],
    ["31 30 00", "Earthwork Methods"], ["31 31 00", "Soil Treatment"],
    ["31 32 00", "Soil Stabilization"], ["31 50 00", "Excavation Support and Protection"],
  ] },
  { division: "32", name: "Exterior Improvements", costType: "subcontract", sections: [
    ["32 01 00", "Operation and Maintenance of Exterior Improvements"], ["32 10 00", "Bases, Ballasts, and Paving"],
    ["32 12 00", "Flexible Paving"], ["32 13 00", "Rigid Paving"],
    ["32 14 00", "Unit Paving"], ["32 17 00", "Paving Specialties"],
    ["32 30 00", "Site Improvements"], ["32 31 00", "Fences and Gates"],
    ["32 80 00", "Irrigation"], ["32 90 00", "Planting"],
  ] },
  { division: "33", name: "Utilities", costType: "subcontract", sections: [
    ["33 05 00", "Common Work Results for Utilities"], ["33 10 00", "Water Utilities"],
    ["33 30 00", "Sanitary Sewerage Utilities"], ["33 40 00", "Storm Drainage Utilities"],
    ["33 50 00", "Fuel Distribution Utilities"], ["33 60 00", "Hydronic and Steam Energy Utilities"],
    ["33 70 00", "Electrical Utilities"], ["33 80 00", "Communications Utilities"],
  ] },
] as const

export const CSI_MASTERFORMAT_ROW_COUNT = CSI_MASTERFORMAT_DIVISIONS.reduce(
  (total, division) => total + 1 + division.sections.length,
  0,
)
