// Everyone who is logged in may search and read; only admins change documents.
using { VectorDocumentService } from 'cap-hana-vector-publisher/srv';

annotate VectorDocumentService.upload with @requires: 'DocumentAdminRole';
annotate VectorDocumentService.deleteDocument with @requires: 'DocumentAdminRole';
annotate VectorDocumentService.embedPending with @requires: 'DocumentAdminRole';
