export const descriptions = {
  connect:
    'Make your first request to TVmaze. It needs no API key. Inspect one response before deciding what to fetch.',
  load: 'Build an ETL pipeline with your agent: fetch around 250 shows (or more if you choose), flatten their episodes into rows, and load two local tables (cast is optional). No records are bundled.',
  model:
    'Define your fields, ontology concepts, relationships and metrics. Keep missing values unknown and separate a show ending from its story reaching a conclusion.',
  query:
    'Dogsled lets you query the models and metrics you built. Ask your agent a question in plain English or use your own SQL tool. Choose your first question before running it; later, save useful selection rules as another model.',
  federate:
    'Join your local shortlist to selected Wikipedia articles through an API source. Dogsled fetches or reuses cached article rows and joins them locally; the request receipts explain which happened.',
  transform:
    'Assess every finalist against the same preference using article passages. Compare supporting evidence and unknowns, then query your recommendations.',
  resolve:
    'Match your own watchlist against TVmaze search candidates. Use shared IDs first; review real title, year and country ambiguities. Accepted matches can remove shows you have already watched.',
};
export const prompts = {
  connect:
    'Follow the TV Night guide. Help me connect to TVmaze, inspect a response, verify connect, and refresh this page.',
  load: 'Help me fetch around 250 TV series with an adjustable page list and build the TVmaze ETL for shows and episodes (cast is optional). Run it, verify load, and refresh this page.',
  model:
    'Help me describe the fields, add an ontology and mapping for Episode, Show and ProductionStatus, and validate them. Explain why episode counts differ from show counts and why Ended does not prove story closure. Then define relationships and metrics and build shows and episodes models from the raw tables. Verify model and refresh this page.',
  query:
    'Introduce how Dogsled queries my models and metrics. Offer example questions and invite my own. Wait for my question before running a query; after exploration, help me decide whether to save useful rules as a model.',
  federate:
    'Link selected shows to Wikidata and Wikipedia. Configure a bounded Wikipedia API source and join its articles to the local shows. Verify federate and refresh this page.',
  transform:
    'Help me fetch full articles and prepare bounded passages for every finalist. Assess the same preference for each within the API usage approved at setup and any chosen dollar cap. Have AI select passage IDs and code attach the exact text. Run one pilot, verify transform --show-id for that ID, and pause for inspection before the remaining shows. Use only explicitly approved recovery attempts for failed or rejected IDs; keep automatic retries disabled. Review the explanations as well as passage IDs and mark weak reasoning as needs review. After the remaining runs or any recovery, explain the actual model chain, show the agentic YAML and executor, distinguish querying saved results from running AI, then give a brief comparison and a file-focused inspection pause. Build recommendations and run the full technical check only when every finalist has valid saved output; this does not close the quality review.',
  resolve:
    'Use my watchlist and TVmaze search candidates for a real entity-resolution pipeline. Review ambiguous pairs, preserve unresolved records, and exclude accepted watched shows from recommendations.',
};
