import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, onSnapshot, query, orderBy, doc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCfvDkaVXt9nVfZeAnWvOC5q3iZ7_CMGJg",
    authDomain: "smart-todo-app-5fcca.firebaseapp.com",
    projectId: "smart-todo-app-5fcca",
    storageBucket: "smart-todo-app-5fcca.firebasestorage.app",
    messagingSenderId: "254079310651",
    appId: "1:254079310651:web:5450581ad51efaf965351e"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const playedAlerts = new Set();
const dismissedAlerts = new Set(); 
let itemPendingDeletion = null; 
let activelyRingingAudio = null; 
let currentRingingTaskId = null; // Tracks precisely which task is active to prevent stream flooding
let localTasksArray = []; 

const bootstrapDeleteModal = new bootstrap.Modal(document.getElementById('deleteModal'));
const bootstrapAlarmModal = new bootstrap.Modal(document.getElementById('alarmModal'));

if (Notification.permission !== "granted") {
    Notification.requestPermission();
}

const taskForm = document.getElementById('taskForm');
const taskList = document.getElementById('taskList');
const notificationArea = document.getElementById('notificationArea');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
const dismissAlarmBtn = document.getElementById('dismissAlarmBtn');

// GLOBAL AUDIO ENGINE UNLOCKER (Wakes up HTML5 Audio on your very first click)
document.addEventListener('click', () => {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    if (context.state === 'suspended') {
        context.resume();
    }
    console.log("🔊 Browser audio engine successfully unlocked via user interaction!");
}, { once: true });

// 1. Submit Form to Firestore
taskForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('taskTitle').value;
    const deadline = document.getElementById('taskDeadline').value;
    const offsetMinutes = parseInt(document.getElementById('taskOffset').value);
    const assignedTone = document.getElementById('taskTone').value;

    try {
        await addDoc(collection(db, "todos"), {
            title: title,
            deadline: deadline,
            offset: offsetMinutes, 
            tone: assignedTone,
            createdAt: new Date()
        });
        taskForm.reset(); 
    } catch (error) {
        console.error("Error saving task: ", error);
    }
});

// 2. Real-time Firebase Listener
const q = query(collection(db, "todos"), orderBy("deadline", "asc"));

onSnapshot(q, (snapshot) => {
    localTasksArray = []; 
    snapshot.forEach((snapshotDoc) => {
        localTasksArray.push({
            id: snapshotDoc.id,
            ...snapshotDoc.data()
        });
    });
    renderTasksRealTime();
});

// 3. Render Loop
function renderTasksRealTime() {
    taskList.innerHTML = ""; 
    notificationArea.innerHTML = ""; 
    
    if (localTasksArray.length === 0) {
        taskList.innerHTML = `<li class="list-group-item text-center py-4 bg-transparent border-0 text-white-50">No plans listed yet. Add one above!</li>`;
        return;
    }

    localTasksArray.forEach((task) => {
        const now = new Date();
        const deadlineDate = new Date(task.deadline);
        
        const minutesOffset = task.offset || 0;
        const alarmTriggerDate = new Date(deadlineDate.getTime() - (minutesOffset * 60 * 1000));
        
        const timeDiff = alarmTriggerDate - now; 
        const minutesLeft = timeDiff / (1000 * 60);
        const daysLeft = timeDiff / (1000 * 60 * 60 * 24); 

        let badgeHTML = `<span class="badge bg-secondary px-3 py-2 rounded-pill">Scheduled</span>`;
        let cardBorderClass = "border-purple-accent"; 
        
        if (dismissedAlerts.has(task.id)) {
            badgeHTML = `<span class="badge bg-dark text-white-50 px-3 py-2 rounded-pill">Acknowledged</span>`;
            cardBorderClass = "border-secondary opacity-50";
        } else if (minutesLeft <= 0) {
            badgeHTML = `<span class="badge bg-danger px-3 py-2 rounded-pill">🚨 Alert Active</span>`;
            cardBorderClass = "border-danger border-2";

            // OPTIMIZED: Checks both sets and current status to prevent stream stacking crashes
            if (!playedAlerts.has(task.id) && currentRingingTaskId !== task.id) {
                playedAlerts.add(task.id);
                currentRingingTaskId = task.id; 
                dismissAlarmBtn.setAttribute('data-active-id', task.id);
                
                const specificToneFile = task.tone || "beep.mp3";
                
                // Clear out stale loops smoothly before creating a new sound connection resource
                if (activelyRingingAudio) { 
                    try {
                        activelyRingingAudio.pause();
                        activelyRingingAudio.src = ""; 
                    } catch(e) {}
                }
                
                activelyRingingAudio = new Audio(specificToneFile);
                activelyRingingAudio.loop = true; 
                
                const playPromise = activelyRingingAudio.play();
                if (playPromise !== undefined) {
                    playPromise
                        .then(() => console.log(`🎵 Playing audio: ${specificToneFile}`))
                        .catch(err => console.error("Audio playback paused by browser policy parameters:", err));
                }
                
                const formattedDeadlineText = deadlineDate.toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
                document.getElementById('alarmTaskTitle').innerText = task.title || "Untitled Plan";
                document.getElementById('alarmModalTime').innerText = `⚠️ Early warning reminder! Your absolute deadline is scheduled for: ${formattedDeadlineText}`;
                
                bootstrapAlarmModal.show();
                triggerSystemNotification(task.title);
            }
        } else if (minutesLeft > 0 && minutesLeft <= 60) {
            const minsRounded = Math.ceil(minutesLeft);
            badgeHTML = `<span class="badge bg-danger text-white px-3 py-2 rounded-pill fw-bold blink-animation">⏳ Alert in ${minsRounded} mins</span>`;
            cardBorderClass = "border-danger border-2";
            showBannerAlert(task.title);
        } else if (daysLeft > 0 && daysLeft <= 2) {
            badgeHTML = `<span class="badge bg-warning text-dark px-3 py-2 rounded-pill fw-bold">⚠️ Alert within 2 Days</span>`;
            cardBorderClass = "border-warning border-2"; 
            showBannerAlert(task.title);
        }

        const formattedDeadlineDate = deadlineDate.toLocaleString([], {dateStyle: 'medium', timeStyle: 'short'});
        let offsetLabel = "Exactly on time";
        if (minutesOffset === 5) offsetLabel = "5 mins early";
        if (minutesOffset === 60) offsetLabel = "1 hour early";
        if (minutesOffset === 1440) offsetLabel = "1 day early";

        const li = document.createElement('li');
        li.className = `list-group-item d-flex justify-content-between align-items-center py-3 mb-3 text-white rounded purple-card shadow-aesthetic border-start border-4 ${cardBorderClass}`;
        li.style.backgroundColor = "#1d0d30"; 
        li.innerHTML = `
            <div>
                <strong class="d-block h5 mb-1 text-white">${task.title || "Untitled Plan"}</strong>
                <small class="text-white-50">🚨 Actual Deadline: ${formattedDeadlineDate}</small>
                <div class="text-white-50 mt-1" style="font-size: 11px;">🎵 Tone: ${task.tone || "Beep"} | ⏰ Setup: Alert ${offsetLabel}</div>
            </div>
            <div class="d-flex align-items-center gap-3">
                ${badgeHTML}
                <button class="btn btn-outline-danger btn-sm rounded-circle delete-btn" data-id="${task.id}" style="width: 30px; height: 30px; padding: 0; line-height: 1;" title="Cancel Event">
                    ✕
                </button>
            </div>
        `;
        taskList.appendChild(li);
    });

    // Safely refresh structural click listener loops
    document.querySelectorAll('.delete-btn').forEach(button => {
        button.replaceWith(button.cloneNode(true));
    });

    document.querySelectorAll('.delete-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            itemPendingDeletion = e.target.getAttribute('data-id'); 
            bootstrapDeleteModal.show(); 
        });
    });
}

// 4. Heartbeat Sync Check
setInterval(() => {
    if (localTasksArray.length > 0) {
        renderTasksRealTime();
    }
}, 5000);

// Delete Confirmation
confirmDeleteBtn.addEventListener('click', async () => {
    if (itemPendingDeletion) {
        try {
            await deleteDoc(doc(db, "todos", itemPendingDeletion));
            bootstrapDeleteModal.hide(); 
            itemPendingDeletion = null;
        } catch (error) {
            console.error("Error deleting item: ", error);
        }
    }
});

// Dismiss Alarm
dismissAlarmBtn.addEventListener('click', () => {
    if (activelyRingingAudio) {
        activelyRingingAudio.pause();
        activelyRingingAudio.currentTime = 0;
        activelyRingingAudio = null; 
    }
    
    const activeTaskId = dismissAlarmBtn.getAttribute('data-active-id');
    if (activeTaskId) {
        dismissedAlerts.add(activeTaskId);
    }
    
    currentRingingTaskId = null; // Free tracking flag channel
    bootstrapAlarmModal.hide();
    renderTasksRealTime();
});

function showBannerAlert(title) {
    const alertDiv = document.createElement('div');
    alertDiv.className = "alert alert-warning alert-dismissible fade show mb-4 fw-bold shadow-lg";
    alertDiv.role = "alert";
    alertDiv.innerHTML = `
        📌 <strong>Upcoming Alert:</strong> The plan <strong>"${title}"</strong> has an early warning tracking trigger closing in!
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;
    notificationArea.appendChild(alertDiv);
}

function triggerSystemNotification(title) {
    if (Notification.permission === "granted") {
        new Notification("⏰ Early Alarm Reminder!", {
            body: `Your tracking alert for "${title}" has been triggered!`,
        });
    }
}