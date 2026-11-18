/**
 * The messages the server writes, in the interface language.
 *
 * The interface is translated by the language packs; the texts the server
 * composes (errors, notices) are not, because they are born inside the code.
 * This table covers them by key: each entry carries the Italian sentence and
 * the English one.
 *
 * A sentence is composed with `message(key, args)`, which picks the language
 * where the sentence is born. The language comes from the request
 * (`x-app-language`): `main.ts` puts it on `res` and makes it current with
 * `withLanguage`, so even a deep helper can compose its sentence without
 * receiving it as a parameter.
 *
 * `translateMessage` is the other way round, for a text that was composed
 * earlier, in the base language, and is read later by someone else: a job's
 * reason (written by the worker, which runs under no language) or a literal
 * that has not become a key yet. It finds the sentence again by its Italian —
 * by exact string, or by the shape of a sentence with placeholders — and gives
 * back the English one.
 * @module messages
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** A sentence in the two languages. Placeholders are `{name}`. */
export interface MessageEntry {
  /** The Italian sentence, as written in the code. */
  readonly it: string
  /** The same sentence in English. */
  readonly en: string
}

/**
 * Key → sentence. Keys are stable and are not translated: they are the contract
 * between the place where the sentence is composed and this table.
 *
 * An `it` without placeholders is also the string `translateMessage` looks up
 * for the call sites that have not been converted: two entries cannot have the
 * same `it` (one would overwrite the other on the exact-match path).
 */
export const MESSAGES = {
  'media.videoUnreadable': { it: 'non riesco a leggere il video', en: 'cannot read the video' },
  'file.notFound': { it: 'file non trovato', en: 'file not found' },
  'workflow.titleRequired': { it: 'serve un titolo', en: 'a title is needed' },
  'graph.empty': { it: 'il grafo è vuoto', en: 'the graph is empty' },
  'graph.apiObject': { it: 'il grafo deve essere un oggetto JSON in formato API', en: 'the graph must be a JSON object in API format' },
  'change.failed': { it: 'modifica non riuscita', en: 'the change did not work' },
  'write.failed': { it: 'scrittura non riuscita', en: 'the write did not work' },
  'comfy.unreachable': { it: 'ComfyUI non raggiungibile', en: 'ComfyUI is unreachable' },
  'clip.trimFailed': { it: 'taglio non riuscito', en: 'the trim did not work' },
  'clip.mergeFailed': { it: 'unione non riuscita', en: 'the merge did not work' },
  'clip.firstSizeUnreadable': { it: 'non riesco a leggere la misura del primo video', en: 'cannot read the size of the first video' },
  'clip.videoNameRequired': { it: 'serve il nome di un video della galleria', en: 'the name of a gallery video is needed' },
  'clip.videoRequired': { it: 'serve un video della galleria', en: 'a gallery video is needed' },
  'clip.videoCount': { it: 'servono da 2 a 20 video della galleria', en: 'between 2 and 20 gallery videos are needed' },
  'clip.selectionTooShort': { it: 'il tratto deve durare almeno 0,2 secondi', en: 'the selection must last at least 0.2 seconds' },
  'clip.startPastEnd': { it: 'l’inizio è oltre la fine del video', en: 'the start is past the end of the video' },
  'locale.invalidCode': { it: 'codice lingua non valido', en: 'invalid language code' },
  'locale.baseLanguage': { it: "l'inglese è la lingua di base, compilata: non si installa né si rimuove", en: 'English is the compiled base language: it is neither installed nor removed' },
  'locale.notAvailable': { it: 'il repository non spedisce un pacchetto «{code}»', en: 'the repository ships no "{code}" language pack' },
  'locale.notInstalled': { it: 'nessun pacchetto {code} installato', en: 'no {code} language pack is installed' },
  'locale.packEmpty': { it: '{file} non ha nessuna chiave', en: '{file} has no keys' },
  'route.unknown': { it: 'rotta sconosciuta: {method} {path}', en: 'unknown route: {method} {path}' },
  'security.crossSite': { it: 'richiesta rifiutata: arriva da un’altra origine', en: 'request refused: it comes from another origin' },
  'file.nameRequired': { it: 'serve il nome di un file della galleria', en: 'the name of a gallery file is needed' },
  'gallery.notAFile': { it: '{name} non è un file della galleria', en: '{name} is not a gallery file' },
  'frame.timeRequired': { it: 'serve un istante in secondi', en: 'a time in seconds is needed' },
  'frame.noneAtThatTime': { it: 'nessun fotogramma a quell’istante (oltre la fine del video?)', en: 'no frame at that instant (past the end of the video?)' },
  'frame.extractFailed': { it: 'estrazione fallita', en: 'the frame extraction did not work' },
  'like.required': { it: 'servono name e liked', en: 'name and liked are needed' },
  'llm.noVisionModel': { it: 'nessun modello di visione configurato', en: 'no vision model is configured' },
  'llm.visionSilent': { it: 'la visione non ha risposto', en: 'the vision model did not answer' },
  'llm.unknownProvider': { it: 'provider LLM sconosciuto: {name}', en: 'unknown LLM provider: {name}' },
  'cover.invalidKey': { it: 'chiave della copertina non valida', en: 'invalid cover key' },
  'cover.empty': { it: 'il file è vuoto', en: 'the file is empty' },
  'cover.notMedia': {
    it: 'il file non è un’immagine né un video: ammessi webp, png, jpg, mp4 e webm',
    en: 'the file is neither an image nor a video: webp, png, jpg, mp4 and webm are accepted',
  },
  'cover.tooLarge': { it: 'la copertina supera il limite di {max} MB', en: 'the cover is over the {max} MB limit' },
  'locale.packObject': { it: '{file} deve essere un oggetto di chiavi e testi', en: '{file} must be an object of keys and texts' },
  'locale.packMissing': { it: 'nessun pack {code}: {reason}', en: 'no {code} language pack: {reason}' },
  'gateway.unreachable': { it: 'il gateway non risponde: {reason}', en: 'the gateway is not answering: {reason}' },
  'json.invalid': { it: 'JSON non valido', en: 'invalid JSON' },
  'json.objectRequired': { it: 'serve un oggetto JSON', en: 'a JSON object is needed' },
  'body.tooLarge': { it: 'richiesta troppo grande', en: 'the request is too large' },
  'password.tooShort': { it: 'la password deve avere almeno 8 caratteri', en: 'the password must be at least 8 characters' },
  'password.notSet': { it: 'imposta prima una password', en: 'set a password first' },
  'password.badRecord': { it: 'record della password non valido', en: 'invalid password record' },
  'route.methodNotAccepted': { it: 'metodo non ammesso', en: 'method not allowed' },
  'still.photoRequired': { it: 'serve una foto della galleria', en: 'a gallery photo is needed' },
  'still.regionInvalid': { it: 'il riquadro da tenere non è valido', en: 'the area to keep is not valid' },
  'still.sizeUnreadable': { it: 'non riesco a leggere la misura della foto', en: 'cannot read the size of the photo' },
  'still.cropFailed': { it: 'ritaglio non riuscito', en: 'the crop did not work' },
  'still.copyFailed': { it: 'copia non riuscita', en: 'the copy did not work' },
  'still.maskMissing': { it: 'manca la zona da togliere', en: 'the area to remove is missing' },
  'app.unreachableTitle': { it: '{name} non risponde', en: '{name} does not answer' },
  'app.unreachableBody': {
    it: 'Il plugin {name} mostra qui un programma che gira per conto suo, e su {url} non risponde nessuno. Installa e avvia {name}, poi scrivi il suo indirizzo in Plugin → {name}.',
    en: 'The {name} plugin shows here a program that runs on its own, and nothing answers at {url}. Install and start {name}, then enter its address in Plugins → {name}.',
  },
  'app.unreachableDetail': { it: 'Errore: {error}', en: 'Error: {error}' },
  'setup.unknown': {
    it: 'A ComfyUI mancano cose che Imagine non sa installare da solo: {what}. Vanno messe a mano (nodi in custom_nodes, modelli nelle cartelle di models).',
    en: 'ComfyUI is missing things Imagine cannot install by itself: {what}. Add them by hand (nodes in custom_nodes, models in the models folders).',
  },
  'setup.askFirst': {
    it: 'Per questa azione ComfyUI deve prima installare: {what}. Avviala dalla chat per confermare, oppure accendi «Installa automaticamente» in Impostazioni.',
    en: 'For this action ComfyUI first has to install: {what}. Start it from the chat to confirm, or turn on «Install automatically» in Settings.',
  },
  'setup.banned': {
    it: 'Il registro di ComfyUI ha bandito {what}: Imagine non lo installa. Serve un\'altra azione o una versione nuova di Imagine.',
    en: 'The ComfyUI registry has banned {what}: Imagine does not install it. Use another action, or a newer Imagine.',
  },
  'setup.hfGated': {
    it: 'Questa azione usa {what}, che Hugging Face dà solo a chi ha accettato la licenza: apri {url} con il tuo account, accettala, poi crea una chiave (Impostazioni → Access Tokens, tipo «Read») e scrivila in Impostazioni → Installazione su ComfyUI.',
    en: 'This action uses {what}, which Hugging Face only serves to accounts that accepted its licence: open {url} with your account, accept it, then create a token (Settings → Access Tokens, type «Read») and enter it in Settings → ComfyUI setup.',
  },
  'setup.declined': { it: 'Installazione non confermata: richiesta annullata.', en: 'Install not confirmed: request cancelled.' },
  'setup.failed': { it: 'Installazione su ComfyUI non riuscita: {reason}', en: 'Installing on ComfyUI failed: {reason}' },
  'setup.stillMissing': { it: 'Dopo l\'installazione a ComfyUI manca ancora: {what}', en: 'After the install ComfyUI is still missing: {what}' },
  'setup.restartTimeout': { it: 'ComfyUI non è ripartito entro {minutes} minuti dall\'installazione.', en: 'ComfyUI did not come back within {minutes} minutes of the install.' },
  'still.iopaintUnreachable': { it: 'IOPaint non raggiungibile o troppo lento', en: 'IOPaint is unreachable or too slow' },
  'still.iopaintAnswered': { it: 'IOPaint ha risposto {status}: {detail}', en: 'IOPaint answered {status}: {detail}' },
  'segments.nothingListed': { it: 'il modello non ha elencato niente nella foto', en: 'the model listed nothing in the photo' },
  'segments.noIndex': { it: 'ComfyUI non ha restituito i segmenti', en: 'ComfyUI returned no segments' },
  'segments.fileMissing': { it: 'file del segmento non trovato', en: 'segment file not found' },
  'tag.nameRequired': { it: 'serve un nome', en: 'a name is needed' },
  'tag.notFound': { it: 'tag non trovato', en: 'tag not found' },
  'tag.unknownAction': { it: 'azione sconosciuta', en: 'unknown action' },
  'settings.baseUrl': { it: 'server.baseURL deve essere un indirizzo http(s)', en: 'server.baseURL must be an http(s) address' },
  'settings.positiveInteger': { it: '{where} deve essere un numero intero positivo', en: '{where} must be a positive whole number' },
  'settings.pathStyle': { it: 'server.pathStyle deve essere auto, posix o nt', en: 'server.pathStyle must be auto, posix or nt' },
  'settings.preview': { it: 'server.preview deve essere true o false', en: 'server.preview must be true or false' },
  'settings.restartCommand': { it: 'server.restartCommand deve essere una lista di argomenti non vuoti', en: 'server.restartCommand must be a list of non-empty arguments' },
  'settings.notConfigurable': { it: '{where} non è un campo configurabile', en: '{where} is not a configurable field' },
  'settings.textRequired': { it: '{where} deve essere testo non vuoto', en: '{where} must be non-empty text' },
  'settings.text': { it: '{where} deve essere testo', en: '{where} must be text' },
  'settings.number': { it: '{where} deve essere un numero', en: '{where} must be a number' },
  'settings.minimum': { it: '{where} deve essere almeno {min}', en: '{where} must be at least {min}' },
  'settings.maximum': { it: '{where} deve essere al massimo {max}', en: '{where} must be at most {max}' },
  'settings.list': { it: '{where} deve essere una lista di testi non vuoti', en: '{where} must be a list of non-empty texts' },
  'settings.inputList': {
    it: '{where} deve essere una lista di voci nodeId, field e value (testo, numero, sì/no o collegamento [nodo, uscita])',
    en: '{where} must be a list of nodeId, field and value entries (text, number, true/false or a [node, output] link)',
  },
  'settings.object': { it: '{where} deve essere un oggetto', en: '{where} must be an object' },
  'settings.jsonFile': { it: '{where} deve essere un file .json', en: '{where} must be a .json file' },
  'settings.noLeadingDot': { it: '{where} non vuole il punto iniziale', en: '{where} must not start with a dot' },
  'settings.unknownWorkflow': { it: '{where} non è un workflow conosciuto', en: '{where} is not a known workflow' },
  'settings.serverOneField': { it: 'server vuole un campo solo', en: 'server takes one field only' },
  'settings.outputDirNoChildren': { it: 'outputDir non ha sotto-campi', en: 'outputDir has no sub-fields' },
  'settings.workflowNeedsField': { it: 'workflows.<chiave> vuole un campo', en: 'workflows.<key> needs a field' },
  'settings.noChildren': { it: '{where} non ha sotto-campi', en: '{where} has no sub-fields' },
  'settings.oneLevel': { it: '{where} ha un solo livello', en: '{where} has one level only' },
  'settings.unknownSection': { it: '{name} non è una sezione configurabile', en: '{name} is not a configurable section' },
  'settings.absolutePath': { it: 'outputDir deve essere un percorso assoluto', en: 'outputDir must be an absolute path' },
  'settings.pathNotConfigurable': { it: 'percorso non configurabile', en: 'the path is not configurable' },
  'settings.unreadable': { it: 'imagine-settings.json non leggibile: {reason}', en: 'imagine-settings.json cannot be read: {reason}' },
  'settings.invalidJson': { it: 'imagine-settings.json non è JSON valido: {reason}', en: 'imagine-settings.json is not valid JSON: {reason}' },
  'settings.fileObject': { it: 'il file deve essere un oggetto', en: 'the file must be an object' },
  'settings.version': { it: 'version {found} non è supportata (attesa {expected})', en: 'version {found} is not supported ({expected} expected)' },
  'job.speed': { it: 'Velocità non valida: ammesse {list}.', en: 'invalid speed: accepted values are {list}.' },
  'job.quality': { it: 'Qualità non valida: ammesse {list}.', en: 'invalid quality: accepted values are {list}.' },
  'job.count': { it: 'Quantità non valida: attesi da 1 a {max}.', en: 'invalid quantity: expected 1 to {max}.' },
  'job.candidates': { it: 'Numero di riferimenti non valido: attesi da 1 a {max}.', en: 'invalid number of references: expected 1 to {max}.' },
  'job.objectMode': { it: "Modo di object swap non valido: ammessi {list}.", en: 'invalid object swap mode: accepted values are {list}.' },
  'job.light': { it: 'Luce non valida: ammessi {list}.', en: 'invalid light: accepted values are {list}.' },
  'job.promptRequired': { it: 'prompt obbligatorio', en: 'a prompt is required' },
  'job.sourceInvalid': { it: 'sorgente non valida', en: 'invalid source' },
  'job.noAudio': { it: 'la clip non ha una traccia audio da convertire', en: 'the clip has no audio track to convert' },
  'job.upscaleTarget': { it: 'risoluzione di arrivo non valida: {value} (ammesse {steps})', en: 'invalid target resolution: {value} (accepted: {steps})' },
  'job.already1080': { it: 'il video è già in 1080p', en: 'the video is already 1080p' },
  'job.already4k': { it: "l'immagine è già in 4K", en: 'the image is already 4K' },
  'job.referencePhotoRequired': { it: 'serve la foto di riferimento', en: 'the reference photo is needed' },
  'job.referenceNotGallery': { it: 'il riferimento deve essere una foto della galleria', en: 'the reference must be a gallery photo' },
  'job.objectReferenceRequired': { it: "serve la foto dell'oggetto da mettere nella scena", en: 'the photo of the object to put in the shot is needed' },
  'job.objectPhotoNotAllowed': { it: 'il modo «{mode}» non usa una foto: bastano la clip e la frase', en: 'the “{mode}” mode does not take a photo: the clip and the line are enough' },
  'job.placement': {
    it: 'il riquadro dell\'oggetto deve stare dentro il fotogramma: coordinate fra 0 e 1, larghezza e altezza positive, e il riquadro intero dentro il bordo',
    en: 'the object box must stay inside the frame: coordinates between 0 and 1, a positive width and height, and the whole box inside the edge',
  },
  'job.frameNotGallery': { it: 'il fotogramma deve essere una foto della galleria', en: 'the frame must be a gallery photo' },
  'job.lastFrameNotGallery': { it: "l'ultimo fotogramma deve essere una foto della galleria", en: 'the last frame must be a gallery photo' },
  'job.regionInvalid': { it: 'zona da modificare non valida', en: 'the area to edit is not valid' },
  'job.maskUnreadable': { it: 'la zona dipinta non è leggibile', en: 'the painted area cannot be read' },
  'job.preciseEditNotConfigured': { it: 'la modifica precisa non è configurata', en: 'the precise edit is not configured' },
  'job.objectSwapNotConfigured': { it: "l'object swap non è configurato per il modo «{mode}»", en: 'the object swap is not configured for the “{mode}” mode' },
  'job.actionNotConfigured': { it: 'azione {action} non configurata', en: 'action {action} is not configured' },
  'job.startImageRequired': { it: "serve un'immagine di partenza", en: 'a starting image is needed' },
  'job.videoNeedsExtend': { it: 'per continuare un video serve «estendi», non una foto di partenza', en: 'to continue a video use “extend”, not a starting photo' },
  'job.noLipSyncNotConfigured': {
    it: 'il cambio personaggio senza lip-sync non è configurato (manca workflows.swapPersonNoLipSync)',
    en: 'the character swap without lip-sync is not configured (workflows.swapPersonNoLipSync is missing)',
  },
  'job.characterPhotoRequired': { it: 'serve la foto del nuovo personaggio', en: 'the photo of the new character is needed' },
  'job.plateRequired': { it: 'serve il video da modificare', en: 'the video to modify is needed' },
  'job.recreateVideoRequired': { it: 'serve il video da ricreare', en: 'the video to recreate is needed' },
  'job.regenerateVideoRequired': { it: 'serve il video da rigenerare', en: 'the video to regenerate is needed' },
  'job.startFileRequired': { it: 'serve un file di partenza', en: 'a starting file is needed' },
  'job.trackRequired': { it: 'serve una traccia di partenza', en: 'a starting track is needed' },
  'job.trackOrClipRequired': { it: 'serve una traccia audio o una clip', en: 'an audio track or a clip is needed' },
  'job.notFound': { it: 'job {id} non trovato', en: 'job {id} not found' },
  'request.sizeInvalid': { it: 'Dimensione non valida: attesa «LARGHEZZAxALTEZZA» (per esempio 1080x1920), ricevuto «{size}».', en: 'invalid size: expected «WIDTHxHEIGHT» (for example 1080x1920), received «{size}».' },
  'request.sizeTooLarge': { it: 'Dimensione troppo grande: il massimo per lato è {max} px.', en: 'size too large: the maximum per side is {max} px.' },
  'request.secondsInvalid': { it: 'Durata non valida: attesi da 1 a {max} secondi.', en: 'invalid duration: expected 1 to {max} seconds.' },
  'request.swapResolutionInvalid': { it: 'swapResolution deve essere uno tra {allowed}', en: 'swapResolution must be one of {allowed}' },
  'request.megapixelsInvalid': { it: 'Megapixel non validi: attesi più di 0 e fino a 16.', en: 'invalid megapixels: expected more than 0 and up to 16.' },
  'workflow.notConfigured': { it: 'workflow {key} non configurato', en: 'workflow {key} is not configured' },
  'lora.notAdded': { it: 'LoRA non aggiunta', en: 'the LoRA was not added' },
  'lora.notChanged': { it: 'LoRA non modificata', en: 'the LoRA was not changed' },
  'route.notFound': { it: 'rotta sconosciuta', en: 'unknown route' },
  'chat.readFailed': { it: 'La lettura non è riuscita.', en: 'the reading did not work.' },
  'chat.modelSilent': {
    it: 'Non sono riuscito a leggere la frase: il modello non ha risposto, o ha risposto qualcosa che non so leggere. Non ho generato niente. Riprova, o dimmi in breve cosa vuoi.',
    en: 'I could not read the sentence: the model did not answer, or it answered something I cannot read. Nothing was generated. Try again, or tell me briefly what you want.',
  },
  'chat.unreadable': {
    it: 'Non sono riuscito a leggere la frase. Riprova, o dimmi cosa generare.',
    en: 'I could not read the sentence. Try again, or tell me what to generate.',
  },
  'chat.realDuration': {
    it: 'Durata reale: {seconds} s (la scala dello studio).',
    en: 'Real length: {seconds} s (the studio’s ladder).',
  },
  'chat.notConfigured': {
    it: '«{action}» non è configurato in questa installazione: niente da mettere in coda.',
    en: '“{action}” is not configured in this installation: there is nothing to queue.',
  },
  'chat.customNoCard': {
    it: 'nessun workflow personale indicato: dimmi quale usare.',
    en: 'no personal workflow was named: say which one to use.',
  },
  'chat.cardNotConfigured': {
    it: 'il workflow personale {id} non c’è (o il suo grafo non si carica): niente da mettere in coda.',
    en: 'the personal workflow {id} is not there (or its graph does not load): there is nothing to queue.',
  },
  'chat.workflowUnreadable': {
    it: 'Non sono riuscito a leggere {label}. Riprova a dirmelo.',
    en: 'I could not read {label}. Try telling me again.',
  },
  'chat.maskedRemoval': {
    it: 'Due tentativi hanno rifatto tutta la foto e non hanno tolto quello che chiedevi: un altro remix rifarebbe di nuovo tutto. Per togliere una parte senza toccare il resto, apri la foto e usa «Rimuovi oggetto» (IOPaint): dipingi la zona da togliere, riempie solo quella e il resto resta identico. Per cambiare una zona invece di toglierla c\'è «Modifica precisa». Non avvio un altro remix.',
    en: 'Two attempts already redrew the whole photo and did not take out what you asked: another remix would redraw it again. To take a part out without touching the rest, open the photo and use «Remove object» (IOPaint): paint the area to remove, it fills only that and leaves the rest identical. To change a zone instead of removing it, use «Precise edit». I am not starting another remix.',
  },
  'settings.cannotSave': { it: 'imagine-settings.json non è valido, correggilo a mano prima di salvare: {problem}', en: 'imagine-settings.json is not valid, fix it by hand before saving: {problem}' },
  'path.invalid': { it: 'percorso non valido', en: 'invalid path' },
  'workflow.keyAndChanges': { it: 'servono key e changes', en: 'key and changes are needed' },
  'settings.opsRequired': { it: 'servono le modifiche (ops)', en: 'the changes (ops) are needed' },
  'comfy.noRestartCommand': { it: 'nessun comando di riavvio configurato', en: 'no restart command is configured' },
  'music.lookRequired': { it: 'scegli un look', en: 'choose a look' },
  'request.textRequired': { it: 'testo obbligatorio', en: 'a text is required' },
  'job.actionInvalid': { it: 'azione non valida', en: 'invalid action' },
  'graph.fieldWithoutNode': { it: 'campo "{field}" senza nodo', en: 'field "{field}" has no node' },
  'graph.noNodeForField': { it: 'nessun nodo {node} per il campo {field}', en: 'no node {node} for field {field}' },
  'graph.noField': { it: 'il nodo {node} non ha un campo {field}', en: 'node {node} has no field {field}' },
  'graph.frameInvalid': {
    it: 'il fotogramma {width}x{height} non è valido: i due lati devono essere positivi',
    en: 'the frame {width}x{height} is not valid: both sides must be positive',
  },
  'graph.brokenLinks': { it: 'collegamenti rotti: {links}', en: 'broken links: {links}' },
  'file.noFreeName': { it: 'nessun nome libero per {name}', en: 'no free name for {name}' },
  'workflow.classNodeField': { it: 'servono class o node, e field', en: 'class or node, and field, are needed' },
  'workflow.unknown': { it: 'workflow sconosciuto', en: 'unknown workflow' },
  'workflow.nodeMissing': { it: 'il nodo {node} non esiste in questo workflow', en: 'node {node} does not exist in this workflow' },
  'workflow.nodeNoField': { it: 'il nodo {node} ({class}) non ha un campo {field}', en: 'node {node} ({class}) has no field {field}' },
  'workflow.fieldIsLink': { it: '{path} è un collegamento fra nodi, non un valore', en: '{path} is a link between nodes, not a value' },
  'workflow.fieldType': { it: '{path} vuole un {wanted}, non un {given}', en: '{path} wants a {wanted}, not a {given}' },
  'workflow.valueNotListed': {
    it: 'il valore «{value}» non è fra quelli che {path} accetta: {values}',
    en: 'the value “{value}” is not one {path} accepts: {values}',
  },
  'workflow.valueRange': {
    it: '{path} accetta da {min} a {max}: {value} è fuori',
    en: '{path} accepts {min} to {max}: {value} is outside',
  },
  'workflow.danglingPin': { it: "il pin {pin} punta al nodo {node}, che non c'è", en: 'the pin {pin} points at node {node}, which is not there' },
  'cover.none': { it: 'nessuna copertina', en: 'no cover' },
  'crop.tooLarge': { it: 'Ritaglio troppo grande: il massimo è {max} MB. Ritaglia una porzione più piccola.', en: 'the crop is too large: the maximum is {max} MB. Crop a smaller area.' },
  'crop.imagesOnly': { it: 'Si possono ritagliare solo le immagini.', en: 'only images can be cropped.' },
  'crop.notSaved': { it: 'Il ritaglio non è stato salvato.', en: 'the crop was not saved.' },
  'upload.unsupportedFormat': { it: '«{file}»: formato non supportato. Formati accettati: {accepted}.', en: '«{file}»: unsupported format. Accepted formats: {accepted}.' },
  'upload.empty': { it: '«{file}» è vuoto.', en: '«{file}» is empty.' },
  'upload.contentMismatch': { it: '«{file}»: il contenuto non è un file {ext} valido.', en: '«{file}»: the content is not a valid {ext} file.' },
  'upload.rejected': { it: '«{file}» non è stato accettato.', en: '«{file}» was not accepted.' },
  'upload.invalidList': { it: 'elenco di file non valido', en: 'invalid file list' },
  'change.nothing': { it: 'niente da cambiare', en: 'nothing to change' },
  'custom.editorFormat': { it: "questo è il formato dell'editor di ComfyUI: nel menu del workflow scegli «Esporta (API)» e carica quello", en: "this is the ComfyUI editor's format: in the workflow menu choose «Export (API)» and load that" },
  'custom.nodeNoClass': { it: 'il nodo {node} non ha class_type', en: 'node {node} has no class_type' },
  'custom.inputMissingNode': { it: 'l\'ingresso "{input}" nomina il nodo {node}, che il grafo non ha', en: 'the input "{input}" names node {node}, which the graph does not have' },
  'custom.inputMissingField': { it: 'l\'ingresso "{input}" nomina il campo {field} del nodo {node}, che non c\'è', en: 'the input "{input}" names field {field} of node {node}, which is not there' },
  'custom.pinMissingNode': { it: '{field} nomina il nodo {node}, che il grafo non ha', en: '{field} names node {node}, which the graph does not have' },
  'custom.dataUrlRequired': { it: 'la copertina deve essere un data URL', en: 'the cover must be a data URL' },
  'custom.fieldNeedsNode': { it: 'il campo {field} richiede il nodo {pin}', en: 'the field {field} needs the node {pin}' },
  'custom.fieldMissing': { it: 'il campo {field} del nodo {node} non esiste nel grafo', en: 'the field {field} of node {node} is not in the graph' },
  'custom.batchMissingNode': { it: 'il batch nomina il nodo {node}, che il grafo non ha', en: 'the batch names node {node}, which the graph does not have' },
  'custom.batchMissingField': { it: "il batch nomina il campo {field} del nodo {node}, che non c'è", en: 'the batch names field {field} of node {node}, which is not there' },
  'custom.batchNoValues': { it: 'il batch vuole i valori del campo, e il server non li ha letti', en: "the batch needs the field's values, and the server did not read them" },
  'custom.batchTooFewValues': { it: 'il campo {field} ha {count} valori veri: un batch ne vuole almeno due', en: 'the field {field} has {count} real values: a batch needs at least two' },
  'custom.eitherMalformed': { it: 'il blocco «either» vuole due slot e un interruttore con nodo, campo e slot video', en: 'the either block wants two slots and a switch with node, field and video slot' },
  'custom.eitherMissingNode': { it: 'lo slot {node} del blocco «either» non esiste nel grafo', en: 'the either block names slot {node}, which the graph does not have' },
  /*
   * The Meta token pasted from Settings: the sentences say what is wrong with
   * its shape, never the pasted value.
   */
  'social.fbTokenEmpty': { it: 'incolla almeno uno dei due token (pagina o utente)', en: 'paste at least one of the two tokens (page or user)' },
  'social.checkNoTokens': { it: 'nessun token da verificare', en: 'no token to check' },
  'plugin.unknown': { it: 'plugin {id} sconosciuto', en: 'unknown plugin {id}' },
  'plugin.notInRepo': { it: 'il repository non ha un plugin «{id}»', en: 'the repository has no plugin "{id}"' },
  'plugin.incompatible': { it: 'il plugin {id} parla l\'API {api}; questo studio parla la {expected}', en: 'plugin {id} speaks API {api}; this host speaks {expected}' },
  'plugin.notLoaded': { it: 'il plugin {id} non è caricato: {reason}', en: 'plugin {id} is not loaded: {reason}' },
  'plugin.valuesObject': { it: 'serve un oggetto «values»', en: '"values" must be an object' },
  'plugin.unknownKey': { it: 'il plugin {plugin} non ha il campo «{key}»', en: 'plugin {plugin} has no "{key}" setting' },
  'plugin.badToggle': { it: '«{key}» vuole un booleano', en: '"{key}" wants a boolean' },
  'plugin.badText': { it: '«{key}» vuole una stringa', en: '"{key}" wants a string' },
  'plugin.tooLong': { it: '«{key}» supera {max} caratteri', en: '"{key}" is longer than {max} characters' },
  'plugin.badSelect': { it: '«{key}» vuole uno di: {values}', en: '"{key}" wants one of: {values}' },
  'plugin.statusTimeout': { it: 'lo stato non ha risposto entro {seconds} secondi', en: 'the status did not answer within {seconds} seconds' },
  'social.checkTimeout': { it: 'Meta non ha risposto entro {seconds} secondi', en: 'Meta did not answer within {seconds} seconds' },
  'social.checkUnreachable': { it: 'Meta non raggiungibile: {reason}', en: 'Meta unreachable: {reason}' },
  'social.fbTokenPrefix': { it: 'il token deve cominciare con {prefix}: questo è il formato di Facebook, non quello di Instagram', en: 'the token must start with {prefix}: this is the Facebook form, not the Instagram one' },
  'social.tokenEmpty': { it: 'incolla l\'access token di Meta', en: 'paste the Meta access token' },
  'social.tokenWhitespace': { it: 'il token contiene spazi o a capo: incollalo come un valore solo', en: 'the token contains spaces or newlines: paste it as a single value' },
  'social.tokenLength': { it: 'la lunghezza del token non è plausibile (attesi {min}-{max} caratteri)', en: 'the token length is not plausible ({min}-{max} characters expected)' },
  'social.tokenPrefix': { it: 'il token deve cominciare con {prefix}: questo sembra incollato da un\'altra dashboard', en: 'the token must start with {prefix}: this looks pasted from another dashboard' },
  'social.tokenExpiresInvalid': { it: 'la durata del token non è valida (secondi, fino a un anno)', en: 'the token lifetime is not valid (seconds, up to a year)' },
  'social.tokenUsernameInvalid': { it: 'il nome utente non è valido', en: 'the username is not valid' },
  'lora.nameRequired': { it: 'serve il nome della LoRA', en: 'the LoRA name is needed' },
  'lora.noLoader': { it: 'il grafo non ha un nodo di caricamento del modello (UNETLoader, CheckpointLoader…)', en: 'the graph has no model loader node (UNETLoader, CheckpointLoader…)' },
  'lora.noConsumer': { it: "nessun nodo legge il modello: non c'è dove inserire la LoRA", en: 'no node reads the model: there is nowhere to insert the LoRA' },
  'lora.nodeMissing': { it: 'il nodo {node} non esiste', en: 'node {node} does not exist' },
  'lora.nodeNotLora': { it: 'il nodo {node} non è una LoRA ({class})', en: 'node {node} is not a LoRA ({class})' },
  'lora.strengthRequired': { it: 'la forza deve essere un numero', en: 'the strength must be a number' },
  'lora.noUpstream': { it: 'la LoRA {node} non ha un modello a monte', en: 'LoRA {node} has no upstream model' },
  'zip.noneLeft': { it: 'nessuno dei file selezionati esiste più', en: 'none of the selected files exists any more' },
  'job.timeout': { it: 'il job ha superato il tempo massimo', en: 'the job went past its time limit' },
  'job.queueStopped': { it: "la coda si e' fermata su questo lavoro", en: 'the queue stopped on this job' },
  'job.previousClipMissing': { it: 'il clip precedente non è arrivato', en: 'the previous clip did not arrive' },
  'job.maskLostOnRestart': { it: 'la zona dipinta è andata persa con il riavvio: ridipingila', en: 'the painted area was lost in the restart: paint it again' },
  'job.backgroundSegmentEmpty': { it: 'il segmento del fondo non ha prodotto una clip', en: 'the background segment produced no clip' },
  'job.backgroundNoSegments': { it: 'il fondo non ha reso nessun segmento', en: 'the background produced no segments' },
  'job.backgroundSizeUnreadable': { it: 'non riesco a leggere la misura dei segmenti del fondo', en: 'cannot read the size of the background segments' },
  'job.regenerateWindowEmpty': { it: 'la finestra della rigenerazione non ha prodotto una clip', en: 'the regeneration window produced no clip' },
  'job.regenerateNoWindows': { it: 'la rigenerazione non ha reso nessuna finestra', en: 'the regeneration produced no windows' },
  'job.regenerateSizeUnreadable': { it: 'non riesco a leggere la misura delle finestre della rigenerazione', en: 'cannot read the size of the regeneration windows' },
  'story.longFromImageOrClip': { it: "un video lungo parte da un'immagine o da un clip", en: 'a long video starts from an image or a clip' },
  'story.invalidSong': { it: 'canzone non valida', en: 'invalid song' },
  'story.actionNotConfigured': { it: 'azione story non configurata', en: 'the story action is not configured' },
  'story.empty': { it: 'storia vuota', en: 'empty story' },
  'story.whichClip': { it: 'dimmi quale clip rifare, per esempio la 3/10', en: 'say which clip to redo, for example 3/10' },
  'story.whichVideo': { it: 'dimmi quale videoclip riprendere: una delle sue clip numerate', en: 'say which videoclip to resume: one of its numbered clips' },
  'story.alreadyComplete': { it: "il montaggio e' gia' completo", en: 'the montage is already complete' },
  'story.noShots': { it: 'il montaggio non ha inquadrature', en: 'the montage has no shots' },
  'story.noShotsToRedo': { it: 'il montaggio non ha inquadrature da rifare', en: 'the montage has no shots to redo' },
  'story.unknownMontage': { it: 'montaggio sconosciuto', en: 'unknown montage' },
  'story.emptyMontage': { it: 'montaggio vuoto', en: 'empty montage' },
  'story.montageMissing': { it: 'non ho più il montaggio di {source}', en: 'I no longer have the montage of {source}' },
  'story.unknownSourcePhoto': { it: 'non so da quale foto era nata la clip {number}', en: "I don't know which photo clip {number} came from" },
  'story.namedMontageMissing': { it: 'non ho più il montaggio {name}', en: 'I no longer have the montage {name}' },
  'story.clipMissing': { it: 'manca la clip {number}', en: 'clip {number} is missing' },
  'story.clipMissingFile': { it: 'manca la clip {number}: {file}', en: 'clip {number} is missing: {file}' },
  'scan.videoSizeUnreadable': { it: 'non riesco a leggere la misura del video da ricreare', en: 'cannot read the size of the video to recreate' },
  'scan.noVisionRead': { it: 'nessun modello di visione ha letto il video da ricreare', en: 'no vision model read the video to recreate' },
  'scan.frameWorkflowNotConfigured': { it: 'il grafo del primo fotogramma non è configurato', en: 'the first-frame graph is not configured' },
  'recreate.noFirstFrame': { it: 'Krea 2 non ha prodotto il primo fotogramma', en: 'Krea 2 produced no first frame' },
  'speak.actionNotConfigured': { it: 'azione speak non configurata', en: 'the speak action is not configured' },
  'speak.textRequired': { it: 'serve il testo da leggere', en: 'the text to read is needed' },
  'speak.timeout': { it: 'il servizio voce non ha risposto in tempo', en: 'the voice service did not answer in time' },
  'speak.failed': { it: 'sintesi non riuscita', en: 'the speech synthesis did not work' },
  'voice.sourceRequired': { it: 'serve la traccia (o la clip) da cui cambiare la voce', en: 'the track (or the clip) to change the voice of is needed' },
  'voice.noTranscript': { it: 'dalla traccia non è uscito testo da rileggere: o non parla, o la separazione non ha trovato la voce', en: 'no text came out of the track to read back: it may not be spoken, or the separation found no voice' },
  'voice.failed': { it: 'cambio voce non riuscito', en: 'the voice change did not work' },
  'speak.serviceAnswered': { it: 'il servizio voce ha risposto {status}{detail}', en: 'the voice service answered {status}{detail}' },
  'music.imageWorkflowNotConfigured': { it: 'generazione immagini non configurata', en: 'image generation is not configured' },
  'music.workflowNotConfigured': { it: 'musica non configurata', en: 'music is not configured' },
  'comfy.restartFailed': { it: 'riavvio non riuscito', en: 'the restart did not work' },
  'graph.noVideoLoader': { it: 'il workflow non ha un nodo LoadVideo per il video di partenza', en: 'workflow has no LoadVideo node for the input video' },
  'upload.noKind': { it: 'upload senza tipo: {name}', en: 'upload without a kind: {name}' },
  'origin.trim': { it: 'Taglio {start}–{stop} s', en: 'Trim {start}–{stop} s' },
  'origin.merge': { it: 'Unione di {count} video', en: 'Merge of {count} videos' },
  'origin.crop': { it: 'Ritaglio {width}×{height}', en: 'Crop {width}×{height}' },
  'origin.copy': { it: 'Copia', en: 'Copy' },
  'origin.erase': { it: 'Oggetto rimosso (IOPaint)', en: 'Object removed (IOPaint)' },
  'origin.frame': { it: 'Fotogramma a {time} s', en: 'Frame at {time} s' },
  /*
   * The login page (`auth.ts`): served before any page of the studio, so it
   * takes its language from the cookie the page writes (`pageLanguageOf`).
   */
  'auth.title': { it: 'Imagine — accesso', en: 'Imagine — sign in' },
  'auth.submit': { it: 'Entra', en: 'Sign in' },
  'auth.tooManyAttempts': { it: 'Troppi tentativi: riprova tra qualche minuto.', en: 'Too many attempts: try again in a few minutes.' },
  'auth.requestTooLarge': { it: 'Richiesta troppo grande.', en: 'The request is too large.' },
  'auth.wrongPassword': { it: 'Password sbagliata.', en: 'Wrong password.' },
  'auth.loginRequired': { it: 'login richiesto', en: 'login required' },
  /*
   * The Instagram plugin (`plugins/instagram`), which bundles this table. Its
   * routes write in the page's language; what the scheduler writes on its own
   * (notices, a scheduled post's progress, the comment pass's notes) in the
   * plugin's «language» setting. Some of these sentences are also read back:
   * the retry and the notice's hint recognise them in both languages
   * (`carries` in the plugin's `context.ts`), so their opening words are part
   * of the contract.
   */
  'social.likeRefused': { it: 'like rifiutato', en: 'like refused' },
  'social.likeTransient': {
    it: 'Meta non applica il like (errore interno #2, is_transient): il commento si legge ma il like viene rifiutato da Instagram. Riprovo al prossimo passaggio.',
    en: 'Meta does not apply the like (internal error #2, is_transient): the comment can be read, but Instagram refuses the like. I will try again on the next pass.',
  },
  'social.alreadyLiked': { it: 'già messo like', en: 'already liked' },
  'social.alreadyReplied': { it: 'già risposto', en: 'already replied' },
  'social.replyRefused': { it: 'risposta rifiutata', en: 'reply refused' },
  'social.noTextModel': { it: 'Nessun modello di testo configurato (Impostazioni → Generale): nessuna risposta scritta.', en: 'No text model is configured (Settings → General): no reply written.' },
  'social.modelWroteNothing': { it: 'Il modello {model} non ha scritto nulla: la richiesta è finita senza testo. Nessuna risposta scritta.', en: 'The model {model} wrote nothing: the request ended without text. No reply written.' },
  'social.modelSkipped': { it: 'il modello ha scelto di non rispondere', en: 'the model chose not to reply' },
  'social.commentsModelDown': {
    it: 'Il modello non ha risposto per tutti i tentativi: {count} commenti aspettano una risposta. Riprendo al prossimo passaggio.',
    en: 'The model did not answer for every attempt: {count} comments are waiting for a reply. I will resume at the next pass.',
  },
  'social.commentNotFound': { it: 'Commento non trovato', en: 'comment not found' },
  'social.replyTextRequired': { it: 'Serve il testo della risposta', en: 'the reply text is needed' },
  'social.noticeNoFile': { it: '(nessun file)', en: '(no file)' },
  'social.noticeNoDate': { it: '(data non registrata)', en: '(date not recorded)' },
  'social.noticeNoDetail': { it: '(nessun dettaglio)', en: '(no detail)' },
  'social.hintStoryTooLong': { it: "Una storia dura al massimo 61 secondi: il reel da cui nasce e' piu' lungo e va tagliato prima di riprogrammarla.", en: 'A story lasts 61 seconds at most: the reel it comes from is longer and must be cut before scheduling it again.' },
  'social.hintTooLarge': { it: "Instagram accetta al massimo 100 MB per file: il master normalizzato e' troppo pesante, va ricodificato piu' corto o piu' leggero.", en: 'Instagram accepts 100 MB per file at most: the normalised master is too heavy and must be re-encoded shorter or lighter.' },
  'social.hintToken': { it: 'Sembra il token di Meta: controlla GET /plugin/instagram/social/status e rinnova il token prima di riprogrammare.', en: 'It looks like the Meta token: check GET /plugin/instagram/social/status and renew the token before scheduling again.' },
  'social.hintFileGone': { it: "Il file non e' piu' nella gallery di Imagine: rigenera il media o correggi il nome nel post.", en: "The file is no longer in Imagine's gallery: generate the media again or fix the name in the post." },
  'social.noticeStory': { it: 'Storia programmata', en: 'Scheduled story' },
  'social.noticePost': { it: 'Post programmato', en: 'Scheduled post' },
  'social.noticeFailed': { it: '⚠️ {label}: pubblicazione fallita', en: '⚠️ {label}: publishing failed' },
  'social.noticeDueAt': { it: 'Era previsto per: {when}', en: 'It was due at: {when}' },
  'social.noticeContent': { it: 'Contenuto: {source}', en: 'Content: {source}' },
  'social.noticeReason': { it: 'Motivo:', en: 'Reason:' },
  'social.noticeHint': { it: 'Suggerimento: {hint}', en: 'Hint: {hint}' },
  'social.noticeStoryStays': { it: 'Resta in coda con stato error: ComfyUI Imagine → Social → Storie. Non viene ritentata da sola.', en: 'It stays in the queue in the error state: ComfyUI Imagine → Social → Stories. It is not retried on its own.' },
  'social.noticePostStays': { it: 'Resta in coda con stato error: ComfyUI Imagine → Social. Non viene ritentato da solo.', en: 'It stays in the queue in the error state: ComfyUI Imagine → Social. It is not retried on its own.' },
  'social.publishedReel': { it: '✅ Reel pubblicato', en: '✅ Reel published' },
  'social.publishedPhoto': { it: '✅ Post pubblicato', en: '✅ Post published' },
  'social.publishedCarousel': { it: '✅ Carosello pubblicato', en: '✅ Carousel published' },
  'social.publishedStory': { it: '✅ Storia pubblicata', en: '✅ Story published' },
  'social.publishedStoryQueued': { it: '📖 La storia da questo reel esce {when}', en: '📖 The story from this reel runs {when}' },
  'social.publishedNext': { it: '📅 Prossimo post in coda: {when}', en: '📅 Next post in the queue: {when}' },
  'social.publishedNoNext': { it: '📭 Nessun altro post programmato: la coda è vuota.', en: '📭 No other post scheduled: the queue is empty.' },
  'social.publishedNextStory': { it: '📅 Prossima storia: {when}', en: '📅 Next story: {when}' },
  'social.publishedNoNextStory': { it: '📭 Nessun\'altra storia programmata.', en: '📭 No other story scheduled.' },
  'social.publishedReportLater': { it: "📊 L'andamento arriva tra 24 ore.", en: '📊 How it is doing comes in 24 hours.' },
  'social.insightsReel': { it: "📊 Reel: com'è andato nelle prime 24 ore", en: '📊 Reel: its first 24 hours' },
  'social.insightsPhoto': { it: "📊 Post: com'è andato nelle prime 24 ore", en: '📊 Post: its first 24 hours' },
  'social.insightsCarousel': { it: "📊 Carosello: com'è andato nelle prime 24 ore", en: '📊 Carousel: its first 24 hours' },
  'social.insightsViews': { it: 'Visualizzazioni', en: 'Views' },
  'social.insightsReach': { it: 'Account raggiunti', en: 'Accounts reached' },
  'social.insightsInteractions': { it: 'Interazioni', en: 'Interactions' },
  'social.insightsWatch': { it: 'Visione media {seconds} s', en: 'Average watch {seconds} s' },
  'social.insightsRate': { it: 'Tasso di interazione {rate}% (interazioni / raggiunti)', en: 'Engagement rate {rate}% (interactions / reached)' },
  'social.insightsCompared': { it: 'Tra parentesi: rispetto alla mediana degli ultimi {count} alle loro 24 ore.', en: 'In brackets: against the median of the last {count} at their own 24 hours.' },
  'social.insightsBest': { it: '🏆 Il migliore degli ultimi {count}.', en: '🏆 The best of the last {count}.' },
  'social.insightsWorst': { it: '🔻 Il più debole degli ultimi {count}.', en: '🔻 The weakest of the last {count}.' },
  'social.insightsNoBaseline': { it: 'Il confronto con i precedenti compare dal quarto resoconto.', en: 'The comparison with the previous ones appears from the fourth report.' },
  'social.tokenExpiringNotice': { it: '⏳ Il token Instagram scade tra {days} giorni e il rinnovo automatico non l\'ha ancora rinnovato: controlla instagram-token-refresh nel container di Imagine.', en: '⏳ The Instagram token runs out in {days} days and the automatic refresh has not renewed it: check instagram-token-refresh in the Imagine container.' },
  'social.tokenExpiredNotice': { it: '⛔ Il token Instagram è scaduto: le pubblicazioni programmate falliranno finché non viene rinnovato (Impostazioni → Plugin → Instagram).', en: '⛔ The Instagram token has expired: scheduled publications will fail until it is renewed (Settings → Plugins → Instagram).' },
  'social.queueTitle': { it: '🗓 Coda di pubblicazione', en: '🗓 Publishing queue' },
  'social.queueEmpty': { it: '📭 Nessun post programmato: la coda è vuota.', en: '📭 No post scheduled: the queue is empty.' },
  'social.queueLow': { it: '⚠️ Restano {count} post programmati: l\'ultimo esce {when}.', en: '⚠️ {count} posts left in the queue: the last one goes out {when}.' },
  'social.queueTomorrow': { it: 'Domani ne escono {count}.', en: 'Tomorrow {count} go out.' },
  'social.storiesEmpty': { it: '📭 Nessuna storia programmata.', en: '📭 No story scheduled.' },
  'social.storiesLow': { it: '⚠️ Le storie programmate finiscono {when}.', en: '⚠️ The scheduled stories end {when}.' },
  'social.fbTokenInvalidNotice': { it: '⛔ Meta rifiuta i token dei commenti: like e risposte automatiche ai commenti sono fermi.', en: '⛔ Meta refuses the comment tokens: automatic likes and replies to comments have stopped.' },
  'social.fbTokenPageRefused': { it: 'Token della pagina: {reason}', en: 'Page token: {reason}' },
  'social.fbTokenUserRefused': { it: "Token dell'utente: {reason}", en: 'User token: {reason}' },
  'social.fbTokenInvalidHint': { it: 'Rinnovali in Impostazioni → Plugin → Instagram → token dei commenti.', en: 'Renew them in Settings → Plugins → Instagram → comment tokens.' },
  'social.queueWriteNotice': { it: '🚨 La coda di pubblicazione non si riesce a salvare su disco: funziona finché Imagine resta acceso, ma un riavvio perde tutti i post programmati.', en: '🚨 The publishing queue cannot be saved to disk: it works while Imagine stays up, but a restart loses every scheduled post.' },
  'social.queueWriteHint': { it: 'Controlla spazio e permessi della cartella social nel container di Imagine prima di riavviare.', en: 'Check the space and permissions of the social folder in the Imagine container before restarting.' },
  'social.queueWriteBack': { it: '✅ La coda di pubblicazione si salva di nuovo su disco.', en: '✅ The publishing queue is being saved to disk again.' },
  'social.earlyReel': { it: '🚀 Questo reel sta andando forte', en: '🚀 This reel is taking off' },
  'social.earlyPost': { it: '🚀 Questo post sta andando forte', en: '🚀 This post is taking off' },
  'social.earlyNumbers': { it: '{views} visualizzazioni in {hours} ore: già sopra la mediana dei precedenti a 24 ore ({median}).', en: '{views} views in {hours} hours: already above the previous ones\' median at 24 hours ({median}).' },
  'social.earlyHint': { it: 'È il momento buono per rispondere ai commenti o rilanciarlo in una storia.', en: 'A good moment to answer the comments or share it again in a story.' },
  'social.weeklyTitle': { it: '📅 Riepilogo della settimana', en: '📅 The week in review' },
  'social.weeklyFollowers': { it: '👥 Follower: {count}', en: '👥 Followers: {count}' },
  'social.weeklyFollowersDiff': { it: '👥 Follower: {count} ({diff} in settimana)', en: '👥 Followers: {count} ({diff} this week)' },
  'social.weeklyPublished': { it: '📤 Post pubblicati: {count}', en: '📤 Posts published: {count}' },
  'social.weeklyNoReports': { it: 'Nessun resoconto a 24 ore questa settimana: le medie compaiono dalla prossima.', en: 'No 24-hour report this week: the averages appear from the next one.' },
  'social.weeklyAverages': { it: 'Media per post alle 24 ore ({count} post):', en: 'Average per post at 24 hours ({count} posts):' },
  'social.weeklyCompared': { it: 'Tra parentesi: rispetto alla settimana prima.', en: 'In brackets: against the week before.' },
  'social.weeklyBest': { it: 'Il migliore:', en: 'The best:' },
  'social.weeklyWorst': { it: 'Il più debole:', en: 'The weakest:' },
  'social.attentionTitle': { it: '💬 Commenti da guardare', en: '💬 Comments to look at' },
  'social.attentionPassError': { it: '⚠️ Il giro dei commenti non è andato a buon fine:', en: '⚠️ The comment pass did not go through:' },
  'social.attentionOffensive': { it: '🛑 Offensivi ({count}): non vengono nascosti da soli, decidi tu.', en: '🛑 Offensive ({count}): never hidden on their own, your call.' },
  'social.attentionSpam': { it: '🗑 Probabile spam ({count}):', en: '🗑 Likely spam ({count}):' },
  'social.attentionQuestions': { it: '❓ Domande rimaste senza risposta ({count}):', en: '❓ Questions left without a reply ({count}):' },
  'social.attentionReplyFailed': { it: '⚠️ Risposte non inviate ({count}):', en: '⚠️ Replies not sent ({count}):' },
  'social.attentionMore': { it: '…e altri {count}.', en: '…and {count} more.' },
  'social.attentionWhere': { it: 'Tutti i commenti: ComfyUI Imagine → Social → Commenti.', en: 'All the comments: ComfyUI Imagine → Social → Comments.' },
  'social.postNotOnAccount': { it: 'nessun post con codice {code} su questo account', en: 'no post with code {code} on this account' },
  'social.stepDrive': { it: 'Carico su Google Drive', en: 'Uploading to Google Drive' },
  'social.stepDrivePhoto': { it: 'Carico su Google Drive la foto {n} di {total}', en: 'Uploading photo {n} of {total} to Google Drive' },
  'social.stepChild': { it: 'Instagram scarica la foto {n} di {total}', en: 'Instagram is downloading photo {n} of {total}' },
  'social.stepCarousel': { it: 'Instagram prepara il carosello', en: 'Instagram is preparing the carousel' },
  'social.stepImage': { it: 'Instagram scarica la foto', en: 'Instagram is downloading the photo' },
  'social.stepReel': { it: 'Instagram riceve il video', en: 'Instagram is receiving the video' },
  'social.stepPoll': { it: 'Instagram elabora (controllo {n} di {total})', en: 'Instagram is processing (check {n} of {total})' },
  'social.stepProcessing': { it: 'Instagram elabora', en: 'Instagram is processing' },
  'social.stepUpscale': { it: 'Ingrandisco il video', en: 'Upscaling the video' },
  'social.stepPreflight': { it: 'Preparo il video per Instagram', en: 'Preparing the video for Instagram' },
  'social.stepQuota': { it: 'Controllo la quota di Instagram', en: 'Checking the Instagram quota' },
  'social.stepPublish': { it: 'Pubblico su Instagram', en: 'Publishing on Instagram' },
  'social.stepVerify': { it: 'Recupero il link del post', en: 'Fetching the link of the post' },
  'social.stepFiles': { it: 'Preparo i file', en: 'Preparing the files' },
  'social.fileNotInGallery': { it: 'File non trovato nella gallery: {name}', en: 'file not found in the gallery: {name}' },
  'social.noFileToPublish': { it: 'Nessun file da pubblicare', en: 'no file to publish' },
  'social.scriptRefused': { it: 'lo script ha risposto ok: false', en: 'the script answered ok: false' },
  'social.scriptTimeout': { it: 'timeout dopo {seconds}s', en: 'timed out after {seconds}s' },
  'social.postNotFound': { it: 'Post non trovato', en: 'post not found' },
  'social.fileRequired': { it: 'Serve almeno un file', en: 'at least one file is needed' },
  'social.postAlreadyPublished': { it: "Post gia' pubblicato", en: 'the post is already published' },
  'social.storyAlreadyPublished': { it: "Storia gia' pubblicata", en: 'the story is already published' },
  'social.publishInProgress': { it: "Pubblicazione gia' in corso", en: 'publishing is already in progress' },
  'social.urlRequired': { it: "Serve instagramUrl: l'indirizzo del post pubblicato", en: 'instagramUrl is needed: the address of the published post' },
  'social.urlNoId': { it: 'Non riesco a leggere un id da questo indirizzo: {url}', en: 'cannot read an id from this address: {url}' },
  'social.metaNotConfirmed': { it: 'Meta non conferma questo post: {reason}', en: 'Meta does not confirm this post: {reason}' },
  'social.fileUnreadableShort': { it: 'file non leggibile ({reason})', en: 'file cannot be read ({reason})' },
  'social.fileUnreadable': { it: 'File non leggibile: {reason}', en: 'File cannot be read: {reason}' },
  'social.storyTooHeavy': { it: '{size} MB, oltre i {max} MB di una storia', en: '{size} MB, over the {max} MB of a story' },
  'social.storyWeight': { it: 'Peso: {size} MB (max {max} MB)', en: 'Size: {size} MB (max {max} MB)' },
  'social.storyTooLong': { it: '{seconds} s, oltre i {max} s di una storia', en: '{seconds} s, over the {max} s of a story' },
  'social.storyDuration': { it: 'Durata: {seconds} s (max {max} s per una storia)', en: 'Duration: {seconds} s (max {max} s for a story)' },
  'social.storyNotScheduledTitle': { it: '⚠️ Storia non programmata: il clip non rispetta i limiti di Instagram', en: "⚠️ Story not scheduled: the clip breaks Instagram's limits" },
  'social.storyReelOut': { it: "Il reel {id} e' uscito regolarmente nel feed.", en: 'The reel {id} went out in the feed as normal.' },
  'social.storyWouldBeRefused': {
    it: "Meta avrebbe rifiutato la storia, quindi non e' stata messa in coda. Taglia il clip a 60 secondi (o portalo sotto i 100 MB) e chiedi in chat di riprogrammarla.",
    en: 'Meta would have refused the story, so it was not queued. Cut the clip to 60 seconds (or bring it under 100 MB) and ask in the chat to schedule it again.',
  },
  'social.storyNotQueuedTitle': { it: '⚠️ Storia non messa in coda', en: '⚠️ Story not queued' },
  'social.storyNotQueued': { it: "Il post {id} e' stato pubblicato, ma la sua storia non e' stata programmata.", en: 'The post {id} was published, but its story was not scheduled.' },
  'social.checkStories': { it: 'Controlla ComfyUI Imagine → Social → Storie.', en: 'Check ComfyUI Imagine → Social → Stories.' },
  'social.storyNotFound': { it: 'Storia non trovata', en: 'story not found' },
  'social.storyFileRequired': { it: 'Serve il file della storia', en: 'the story file is needed' },
  'social.fileNotFoundNamed': { it: 'File non trovato: {name}', en: 'file not found: {name}' },
  'social.storyCannotGo': { it: "Non puo' uscire come storia: {reason}", en: 'it cannot go out as a story: {reason}' },
  'social.dateInvalid': { it: 'Data non valida: {value}', en: 'invalid date: {value}' },
  /* The home page's templates: a form the user fills in, and the sentences that refuse it. */
  'template.notFound': { it: 'modello «{id}» non trovato', en: 'no such model: {id}' },
  'template.nothingToRun': { it: 'questo modello non ha niente da eseguire con queste risposte', en: 'this model has nothing to run with these answers' },
  'template.fileNotGallery': { it: 'non è un file della galleria: {name}', en: 'not a gallery file: {name}' },
  'template.photosCount': { it: '{label}: servono da {min} a {max} foto', en: '{label}: between {min} and {max} photos are needed' },
  'template.textRequired': { it: '{label} non può restare vuoto', en: '{label} cannot be left empty' },
  'template.textTooLong': { it: '{label}: {max} caratteri al massimo', en: '{label}: {max} characters at most' },
  'template.valueNotOffered': { it: '{label}: «{value}» non è fra le scelte', en: '{label}: "{value}" is not one of the choices' },
  'template.oneValueOnly': { it: '{label}: va scelto un solo valore', en: '{label}: only one value can be chosen' },
  'template.choiceRequired': { it: '{label}: serve una scelta', en: '{label}: a choice is needed' },
  'template.aspectRequired': { it: '{label}: serve un formato', en: '{label}: a frame is needed' },
  'template.composeFailed': { it: 'non sono riuscito a comporre il file: {reason}', en: 'could not compose the file: {reason}' },
  'template.tooManyItems': { it: '{label}: {max} voci al massimo', en: '{label}: {max} items at most' },
  'template.fileMissing': { it: 'il file non è nella galleria: {name}', en: 'the file is not in the gallery: {name}' },
  'template.partial': {
    it: '{count} passi avviati, poi il modello si è fermato: {reason}',
    en: '{count} steps started, then the model stopped: {reason}',
  },
} as const satisfies Readonly<Record<string, MessageEntry>>

/** A key of the table. */
export type MessageKey = keyof typeof MESSAGES

/** The placeholder values of a sentence. */
export type MessageArgs = Readonly<Record<string, string | number>>

/**
 * The language of the request in progress, for code that composes a sentence
 * without `res` at hand. Work started outside a request has no language and
 * writes in Italian, which is the product's base.
 */
const requestLanguage = new AsyncLocalStorage<string | undefined>()

/**
 * Run `run` under the language of the current request.
 * @param language - the language the client declared, when it did.
 * @param run - the work to do under that language.
 * @returns whatever `run` returns.
 */
export function withLanguage<T>(language: string | undefined, run: () => T): T {
  return requestLanguage.run(language, run)
}

/** The current language, when there is one. */
export function currentLanguage(): string | undefined {
  return requestLanguage.getStore()
}

/**
 * The installation's base language: what the server writes in when nothing
 * says otherwise — a notice composed in the background, a page with no
 * language declared. English unless `IMAGINE_LANGUAGE` starts with `it`;
 * `main.ts` sets it from `language:` in config.yaml at startup.
 *
 * An environment variable and not a module variable: the compiled plugins
 * carry their own copy of this module, and they run in the same process, so
 * the environment is the one place every copy reads alike (2026-11-15: until
 * then the base was a hard-coded Italian).
 * @returns `it` or `en`.
 */
export function baseLanguage(): 'it' | 'en' {
  const value = typeof process === 'undefined' ? undefined : process.env['IMAGINE_LANGUAGE']
  return value !== undefined && value.trim().toLowerCase().startsWith('it') ? 'it' : 'en'
}

/**
 * The language to write in: Italian for `it`, English for any other language
 * (English is the product's base), and the installation's base language
 * ({@link baseLanguage}) when the request declared none.
 * @param language - the code the request declared.
 * @returns the language to compose in.
 */
export function languageKind(language: string | undefined): 'it' | 'en' {
  if (language === undefined || language === '') return baseLanguage()
  return language.startsWith('it') ? 'it' : 'en'
}

/**
 * Fill the `{placeholders}` of a sentence; one without a value stays as it is,
 * so an error does not become a mute sentence.
 * @param template - the sentence with its placeholders.
 * @param args - the values, when the sentence has placeholders.
 * @returns the sentence to show.
 */
function fill(template: string, args?: MessageArgs): string {
  if (args === undefined) return template
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name: string) => {
    const value = args[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * The sentence, in the language of the current request.
 *
 * To be used where the sentence is composed (inside a route or one of its
 * helpers): the text comes out already in the right language, placeholders
 * included.
 * @param key - which sentence.
 * @param args - the values for its placeholders.
 * @returns the sentence to throw or answer with.
 */
export function message(key: MessageKey, args?: MessageArgs): string {
  return messageIn(currentLanguage(), key, args)
}

/**
 * The sentence in a language given by hand, for a caller that has the request
 * but no `withLanguage` around it (the login guard runs before it is set).
 * @param language - the code, or undefined for the base language.
 * @param key - which sentence.
 * @param args - the values for its placeholders.
 * @returns the sentence to show.
 */
export function messageIn(language: string | undefined, key: MessageKey, args?: MessageArgs): string {
  const kind = languageKind(language)
  const text = fill(MESSAGES[key][kind], args)
  if (kind === 'en') rememberComposed(text)
  return text
}

/**
 * The sentences {@link message} composed in English lately. `sendJson` hands
 * every error to `translateMessage`, and one composed here is already in the
 * reader's language: without this, an English page paid a lookup and a walk
 * through every template for each of them, for nothing.
 */
const COMPOSED = new Set<string>()

/** More than the sentences of a few busy minutes: past it the set starts over. */
const COMPOSED_MAX = 512

function rememberComposed(text: string): void {
  if (COMPOSED.size >= COMPOSED_MAX) COMPOSED.clear()
  COMPOSED.add(text)
}

/**
 * The fixed sentences, indexed by Italian text: this is the `sendJson` path,
 * which receives an already composed string and does not know its key.
 */
const ENGLISH_BY_ITALIAN: ReadonlyMap<string, string> = new Map(
  Object.values(MESSAGES)
    .filter(entry => !entry.it.includes('{'))
    .map(entry => [entry.it, entry.en]),
)

/** A sentence with placeholders, as a pattern that reads its values back. */
interface Template {
  readonly pattern: RegExp
  readonly names: readonly string[]
  readonly en: string
}

/**
 * The sentences with placeholders, as patterns over their Italian: the longest
 * fixed text first, so `{where} deve essere testo non vuoto` wins over
 * `{where} deve essere testo` on the sentence both could read.
 */
const TEMPLATES: readonly Template[] = Object.values(MESSAGES)
  .filter(entry => entry.it.includes('{'))
  .map(entry => {
    const names: string[] = []
    const parts = entry.it.split(/\{([A-Za-z][A-Za-z0-9]*)\}/)
    const source = parts.map((part, index) => {
      if (index % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.push(part)
      return '([^]*?)'
    }).join('')
    return { pattern: new RegExp(`^${source}$`), names, en: entry.en, weight: entry.it.replace(/\{[^}]*\}/g, '').length }
  })
  .sort((a, b) => b.weight - a.weight)
  .map(({ pattern, names, en }) => ({ pattern, names, en }))

/**
 * The sentence, in the given language, for a text composed in the base one.
 * @param text - the message the server composed (in Italian, or already in
 *   the reader's language: a text the table does not know goes out as it is).
 * @param language - the interface language, when known.
 * @returns the text to send.
 */
export function translateMessage(text: string, language: string | undefined): string {
  if (languageKind(language) === 'it') return text
  // Composed by `message()` in English: already translated.
  if (COMPOSED.has(text)) return text
  const fixed = ENGLISH_BY_ITALIAN.get(text)
  if (fixed !== undefined) return fixed
  for (const template of TEMPLATES) {
    const found = template.pattern.exec(text)
    if (found === null) continue
    const args: Record<string, string> = {}
    template.names.forEach((name, index) => { args[name] ??= found[index + 1] ?? '' })
    return fill(template.en, args)
  }
  return text
}
