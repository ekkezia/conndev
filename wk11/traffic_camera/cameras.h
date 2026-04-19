#pragma once

struct Camera {
  const char* id;
  const char* name;
  float lat;
  float lon;
  const char* imageUrl;
};

const Camera cameras[] = {
  {
    "ae67eb8d-0aed-4204-b7a1-3621ed9eef65",
    "Tillary St EB @ Jay St",
    40.696002,
    -73.987094,
    "https://webcams.nyctmc.org/api/cameras/ae67eb8d-0aed-4204-b7a1-3621ed9eef65/image"
  },
  {
    "cd52aa01-1d36-4d0a-bf03-79cb78ffadae",
    "Sands St @ Jay St - quad - 149.27",
    40.699972,
    -73.986858,
    "https://webcams.nyctmc.org/api/cameras/cd52aa01-1d36-4d0a-bf03-79cb78ffadae/image"
  },
  {
    "07c5a9ab-38b0-4176-a932-395cded5858e",
    "Cadman Plz West @ Tillary St",
    40.696267,
    -73.991073,
    "https://webcams.nyctmc.org/api/cameras/07c5a9ab-38b0-4176-a932-395cded5858e/image"
  },
  {
    "821d0c4e-f43f-4968-ad2d-566e40e53df6",
    "Atlantic Ave @ Henry St",
    40.690718,
    -73.996235,
    "https://webcams.nyctmc.org/api/cameras/821d0c4e-f43f-4968-ad2d-566e40e53df6/image"
  }
};

const size_t cameraCount = sizeof(cameras) / sizeof(cameras[0]);