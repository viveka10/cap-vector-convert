namespace my.app;

using { cap.hana.vector.VectorStore } from 'cap-hana-vector-publisher';

entity DocumentChunks : VectorStore {}

service LibraryService {
  @readonly entity Chunks as projection on DocumentChunks;
}
