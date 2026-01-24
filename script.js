/*
  Data fetch script. Uses Fetch to get a text file
  every five seconds, and fill its contents into 
  a div on the HTML page. 

  Based on my fetch example (https://tigoe.github.io/html-for-conndev/fetch/). 

  created 30 Dec 2022
  by Tom Igoe
*/

// this function is called once on page load (see below):
let url = 'https://en.wikipedia.org/w/api.php?action=parse&page=Rat&format=json&origin=*'
let mode = 'camera';
function setup() {
  let toggleButton = document.getElementById('toggle-mode');
  
  toggleButton.addEventListener('click', () => {
    let video = document.getElementById('camera');
    let content = document.getElementById('content');
    if (mode === 'wiki') {
      content.style.display = 'none';
      video.style.display = 'block';
      toggleButton.innerText = 'camera';
      mode = 'camera';
    } else {
      content.style.display = 'block';
      video.style.display = 'none';
      toggleButton.innerText = 'wiki';
      mode = 'wiki';
    }
  });

  document.body.addEventListener('mousemove', (event) => {
    const mouseX = event.clientX;
    const mouseY = event.clientY;
    toggleButton.style.transform = `translate(calc(${mouseX}px - 50%), ${mouseY}px)`;
  });
  
  generateDivContent(url);
  startCamera();
  // set an interval to run fetchText() every 5 seconds:
  setInterval(fetchText, 1000);
}

// make an HTTP call to get a text file:
function fetchText() {
  // parameters for the HTTP/S call
  let params = {
    mode: 'cors', // if you need to turn off CORS, use no-cors
    headers: {    // any HTTP headers you want can go here
      'accept': 'application/text'
    }
  }
  // make the HTTP/S call:
  fetch('log.json', params)
    .then(response => response.text())  
    .then(data => getResponse(data))    // get the body of the response
    .catch(error => getResponse(error));// if there is an error
}

// function to call when you've got something to display:
function getResponse(data) {
  // ensure we have a string (errors or objects may be passed here)
  const textData = (typeof data === 'string') ? data : (data && data.message) ? String(data.message) : String(data);
  // extract last non-empty line from the response text
  const lines = textData.split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
  const lastLine = lines.length ? lines[lines.length - 1] : '';
  console.log(lastLine);

  if (!lastLine) return;
  // try to parse JSON, but handle non-JSON lines gracefully
  let result;
  try {
    result = JSON.parse(lastLine);
  } catch (err) {
    console.warn('getResponse: lastLine is not valid JSON, skipping parse:', lastLine);
    return;
  }
  draw(result.device, result.sensor);
}

function draw(name, pos) {
  const hole = document.getElementById('hole');
  if (!hole) return;

  // robustly handle numeric or {x,y} sensor formats
  const px = (pos && typeof pos === 'object') ? (pos.x ?? pos) : pos;
  const py = (pos && typeof pos === 'object') ? (pos.y ?? pos) : pos;

  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const holeW = hole.offsetWidth || 50;
  const holeH = hole.offsetHeight || 50;

  const x = Math.round(map(px, 0, 1023, 0, vw - holeW));
  const y = Math.round(map(py, 0, 1023, 0, vh - holeH));

  // use translate3d for smoother GPU-accelerated transforms
  hole.style.transform = `translate3d(${x}px, ${y}px, 0)`;

  // update or create a label element inside the hole (pseudo-elements aren't selectable)
  let label = hole.querySelector('.hole-label');
  if (!label) {
    label = document.createElement('div');
    label.className = 'hole-label';
    label.style.position = 'absolute';
    label.style.left = '0';
    label.style.top = '-1.6em';
    label.style.width = 'max-content';
    label.style.pointerEvents = 'none';
    label.style.color = 'black';
    label.style.textAlign = 'center';
    hole.appendChild(label);
  }
  label.innerHTML = `<div style="font-size:10px;">${name}</div><div style="font-size:10px;">${x}, ${y}</div>`;
}

// start webcam and keep a hidden video element for drawing frames
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.warn('getUserMedia not supported');
    return;
  }
  if (window._cameraVideo) return; // already started
  let video = document.getElementById('camera');
  if (!video) {
    video = document.createElement('video');
    video.id = 'camera';
    document.body.insertBefore(video, document.body.firstChild);
  }
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.style.display = '';
  window._cameraVideo = video;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    video.srcObject = stream;
    await video.play();
    console.log('camera started');
  } catch (err) {
    console.error('camera error:', err);
  }
}

function generateDivContent(url) {
  fetch(url)
    .then(response => response.json())
    .then(data => {
      console.log(data)
      const html = data.parse.text['*'];
      document.getElementById('content').innerHTML = html;
    })

}
// This is a listener for the page to load.
// This is the command that actually starts the script:
window.addEventListener('DOMContentLoaded', setup);

// UTILS
function map(value, in_min, in_max, out_min, out_max) {
  return (value - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
}