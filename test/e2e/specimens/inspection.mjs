const key = 'inspection-draft';
const el = id => document.getElementById(id);
const notes = el('notes'), photo = el('photo'), preview = el('preview'), result = el('result');
const save = el('save'), clear = el('clear'), offline = el('offline');
const restore = el('import');
const capture = el('capture');
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
  save.disabled = clear.disabled = photo.disabled = restore.disabled = capture.disabled = true;
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
    save.disabled = clear.disabled = photo.disabled = restore.disabled = capture.disabled = false;
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

el('export').onclick = () => {
  const draft = localStorage.getItem(key);
  if (!draft) {
    result.textContent = 'Save a draft before exporting it.';
    return;
  }
  const url = URL.createObjectURL(new Blob([draft], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'inspection-draft.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  result.textContent = 'Draft exported. The file contains your notes and photo.';
};

restore.onchange = async () => {
  const file = restore.files[0];
  if (!file) return;
  restore.disabled = save.disabled = clear.disabled = photo.disabled = capture.disabled = true;
  try {
    if (file.size > 1024 * 1024) throw new Error('Draft too large');
    const draft = JSON.parse(await file.text());
    if (typeof draft?.notes !== 'string' || !(draft.image === undefined ||
      typeof draft.image === 'string' && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(draft.image))) {
      throw new Error('Invalid draft');
    }
    localStorage.setItem(key, JSON.stringify({ notes: draft.notes, image: draft.image }));
    notes.value = draft.notes;
    show(draft.image);
    result.textContent = 'Exported draft restored on this device.';
  } catch {
    result.textContent = 'Could not restore this draft. Your current draft was kept.';
  } finally {
    restore.value = '';
    restore.disabled = save.disabled = clear.disabled = photo.disabled = capture.disabled = false;
  }
};

capture.onclick = async () => {
  let stream;
  capture.disabled = save.disabled = clear.disabled = restore.disabled = photo.disabled = true;
  result.textContent = 'Opening the camera…';
  delete result.dataset.cameraError;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 640 } }, audio: false });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(video.videoWidth, 640);
    canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
    if (!canvas.width || !canvas.height) throw new Error('Camera provided no image');
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    show(canvas.toDataURL('image/jpeg', 0.8));
    photo.value = '';
    result.textContent = 'Photo captured. Save the draft to keep it on this device.';
  } catch (error) {
    result.dataset.cameraError = error.name;
    result.textContent = 'Could not take a photo. You can choose an image instead.';
  } finally {
    stream?.getTracks().forEach(track => track.stop());
    capture.disabled = save.disabled = clear.disabled = restore.disabled = photo.disabled = false;
  }
};

document.querySelector('main').dataset.ready = 'true';
