const key = 'inspection-draft';
const el = id => document.getElementById(id);
const notes = el('notes'), photo = el('photo'), preview = el('preview'), result = el('result');
const save = el('save'), clear = el('clear'), offline = el('offline');
let image;
function show(value) {
  image = value;
  preview.hidden = !value;
  if (value) preview.src = value;
  else preview.removeAttribute('src');
}
try {
  const draft = JSON.parse(localStorage.getItem(key));
  if (draft) {
    notes.value = draft.notes;
    show(draft.image);
    result.textContent = 'Restored your local draft.';
  }
} catch {
  result.textContent = 'Could not restore the local draft.';
}
save.onclick = async () => {
  const draftNotes = notes.value;
  const file = photo.files[0];
  save.disabled = clear.disabled = photo.disabled = true;
  try {
    let selected = image;
    if (file) {
      if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 512 * 1024) {
        result.textContent = 'Choose a PNG or JPEG under 512 KB.';
        return;
      }
      selected = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }
    localStorage.setItem(key, JSON.stringify({ notes: draftNotes, image: selected }));
    show(selected);
    photo.value = '';
    result.textContent = 'Draft saved on this device.';
  } catch {
    result.textContent = 'Could not save your draft. Keep this page open and copy your notes.';
  } finally {
    save.disabled = clear.disabled = photo.disabled = false;
  }
};
offline.onclick = async () => {
  offline.disabled = true;
  result.textContent = 'Preparing the page for offline use…';
  try {
    await window.tendril.publication.saveOffline();
    result.textContent = 'This page is available offline.';
  } catch {
    result.textContent = 'Could not prepare offline use. Try again with a connection.';
  } finally {
    offline.disabled = false;
  }
};
clear.onclick = () => {
  localStorage.removeItem(key);
  notes.value = '';
  photo.value = '';
  show(undefined);
  result.textContent = 'Local draft discarded.';
};

document.querySelector('main').dataset.ready = 'true';
