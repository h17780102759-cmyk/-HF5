/* ============================================================
   存储层：IndexedDB（书籍 + 章节）
   ============================================================ */

const DB_NAME = "xiezuoqi_db";
const DB_VER = 3;
const BOOK_STORE = "books";
const CHAP_STORE = "chapters";

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("浏览器不支持 IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(BOOK_STORE)) {
        const bs = db.createObjectStore(BOOK_STORE, { keyPath: "id" });
        bs.createIndex("updated", "updated");
      }
      if (!db.objectStoreNames.contains(CHAP_STORE)) {
        const cs = db.createObjectStore(CHAP_STORE, { keyPath: "id" });
        cs.createIndex("bookId", "bookId");
        cs.createIndex("order", "order");
      }
    };

    req.onsuccess = (e) => {
      const db = e.target.result;
      const missing =
        !db.objectStoreNames.contains(BOOK_STORE) ||
        !db.objectStoreNames.contains(CHAP_STORE);
      if (missing) {
        const nextVer = db.version + 1;
        db.close();
        dbPromise = null;
        const req2 = indexedDB.open(DB_NAME, nextVer);
        req2.onupgradeneeded = (e2) => {
          const db2 = e2.target.result;
          if (!db2.objectStoreNames.contains(BOOK_STORE)) {
            const bs2 = db2.createObjectStore(BOOK_STORE, { keyPath: "id" });
            bs2.createIndex("updated", "updated");
          }
          if (!db2.objectStoreNames.contains(CHAP_STORE)) {
            const cs2 = db2.createObjectStore(CHAP_STORE, { keyPath: "id" });
            cs2.createIndex("bookId", "bookId");
            cs2.createIndex("order", "order");
          }
        };
        req2.onsuccess = (e2) => resolve(e2.target.result);
        req2.onerror = (e2) => reject(e2.target.error);
        return;
      }
      resolve(db);
    };

    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

export function storeGetAll(storeName) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      })
  );
}

export function storePut(storeName, obj) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(obj);
        tx.oncomplete = () => resolve(obj);
        tx.onerror = () => reject(tx.error);
      })
  );
}

export function storeDelete(storeName, id) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

/* ============ 书籍 / 章节 数据操作 ============ */

export const BOOK_KEY = "xiezuoqi.lastBook.v2";
export const CHAPTER_KEY = "xiezuoqi.lastChapter.v2";

export function newBookId() {
  return "b" + Date.now() + "_" + Math.floor(Math.random() * 10000);
}
export function newChapterId() {
  return "c" + Date.now() + "_" + Math.floor(Math.random() * 10000);
}

export function loadBooks() {
  return storeGetAll(BOOK_STORE).then((list) => {
    list.sort((a, b) => (a.created || 0) - (b.created || 0));
    return list;
  });
}

export function loadChapters(bookId) {
  return storeGetAll(CHAP_STORE).then((list) => {
    const out = list.filter((x) => x.bookId === bookId);
    out.sort((a, b) => (a.order || 0) - (b.order || 0));
    return out;
  });
}

export function createBook(name) {
  const book = {
    id: newBookId(),
    name,
    wordCount: 0,
    created: Date.now(),
    updated: Date.now()
  };
  return storePut(BOOK_STORE, book).then(() => {
    const ch = {
      id: newChapterId(),
      bookId: book.id,
      title: "第一章",
      text: "",
      order: 0,
      updated: Date.now()
    };
    return storePut(CHAP_STORE, ch).then(() => ({ book, chapter: ch }));
  });
}

export function addChapter(bookId, title, order) {
  const ch = {
    id: newChapterId(),
    bookId,
    title,
    text: "",
    order,
    updated: Date.now()
  };
  return storePut(CHAP_STORE, ch).then(() => ch);
}

export function saveChapter(chapter) {
  return storePut(CHAP_STORE, { ...chapter, updated: Date.now() });
}

export function deleteChapter(chapterId) {
  return storeDelete(CHAP_STORE, chapterId);
}

export function deleteBook(bookId) {
  return loadChapters(bookId)
    .then((list) => {
      let chain = Promise.resolve();
      list.forEach((ch) => {
        chain = chain.then(() => storeDelete(CHAP_STORE, ch.id));
      });
      return chain;
    })
    .then(() => storeDelete(BOOK_STORE, bookId));
}

/* ============================================================
   字数统计（与 main.js 的 countStats 保持一致）
   中文 + 英文单词 + 中文标点
   ============================================================ */
export function countChars(text) {
  const s = text || "";
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (s.match(/[A-Za-z0-9]+/g) || []).length;
  const punct = (s.match(/[\u3000-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d\u2026\u2014]/g) || []).length;
  return cjk + words + punct;
}

export function updateBookWordCount(bookId) {
  return storeGetAll(CHAP_STORE).then((all) => {
    let total = 0;
    all.forEach((c) => {
      if (c.bookId !== bookId) return;
      total += countChars(c.text);
    });
    return storeGetAll(BOOK_STORE).then((books) => {
      const book = books.find((b) => b.id === bookId);
      if (book) {
        book.wordCount = total;
        book.updated = Date.now();
        return storePut(BOOK_STORE, book);
      }
    });
  });
}
